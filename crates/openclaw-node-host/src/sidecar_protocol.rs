//! Transport-neutral authenticated framing for an out-of-process node runtime.
//!
//! The product supervisor owns process creation, artifact verification, the
//! local IPC transport, and delivery of [`SidecarSessionKey`] over a protected
//! bootstrap channel. This module starts after that handoff. It provides the
//! version, limit, session-generation, sequence, and authentication invariants
//! shared by every platform adapter.

use std::{
    fmt,
    io::{self, BufReader, Cursor, Read},
    ops::Range,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use hmac::{Hmac, KeyInit, Mac};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::Sha256;
use thiserror::Error;
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    sync::watch,
};
use zeroize::Zeroize;

pub const SIDECAR_PROTOCOL_MAJOR: u16 = 1;
pub const SIDECAR_PROTOCOL_MINOR: u16 = 0;
/// Largest feature mask that every JSON implementation can represent exactly.
pub const SIDECAR_MAX_FEATURE_BITS: u64 = (1 << 53) - 1;
const SIDECAR_BOOTSTRAP_MINOR: u16 = 0;
static NEXT_CHANNEL_INSTANCE_ID: AtomicU64 = AtomicU64::new(1);

const FRAME_MAGIC: [u8; 4] = *b"OCSC";
const AUTH_TAG_BYTES: usize = 32;
const FIXED_HEADER_BYTES: usize = 4 + 2 + 2 + 1 + 8 + 8 + 2 + 4;
const PAYLOAD_LENGTH_OFFSET: usize = 4 + 2 + 2 + 1 + 8 + 8 + 2;
const MIN_FRAME_BYTES: u32 = 65;
#[cfg(test)]
const LENGTH_PREFIX_BYTES: usize = 4;

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SidecarPeerRole {
    Supervisor,
    Runtime,
}

impl SidecarPeerRole {
    const fn outgoing_direction(self) -> SidecarDirection {
        match self {
            Self::Supervisor => SidecarDirection::SupervisorToRuntime,
            Self::Runtime => SidecarDirection::RuntimeToSupervisor,
        }
    }

    const fn expected_remote(self) -> Self {
        match self {
            Self::Supervisor => Self::Runtime,
            Self::Runtime => Self::Supervisor,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SidecarDirection {
    SupervisorToRuntime,
    RuntimeToSupervisor,
}

impl SidecarDirection {
    const fn wire_value(self) -> u8 {
        match self {
            Self::SupervisorToRuntime => 1,
            Self::RuntimeToSupervisor => 2,
        }
    }

    fn from_wire(value: u8) -> Result<Self, SidecarFrameError> {
        match value {
            1 => Ok(Self::SupervisorToRuntime),
            2 => Ok(Self::RuntimeToSupervisor),
            _ => Err(SidecarFrameError::InvalidDirection(value)),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarPeerIdentity {
    pub role: SidecarPeerRole,
    pub name: String,
    pub version: String,
    pub artifact_identity: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarLimits {
    pub max_frame_bytes: u32,
    pub max_in_flight: u16,
    pub bootstrap_timeout_ms: u32,
}

impl SidecarLimits {
    fn validate(self) -> Result<Self, SidecarProtocolError> {
        if self.max_frame_bytes < MIN_FRAME_BYTES {
            return Err(SidecarProtocolError::InvalidLimit("maxFrameBytes"));
        }
        if self.max_in_flight == 0 {
            return Err(SidecarProtocolError::InvalidLimit("maxInFlight"));
        }
        if self.bootstrap_timeout_ms == 0 {
            return Err(SidecarProtocolError::InvalidLimit("bootstrapTimeoutMs"));
        }
        Ok(self)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarProtocolOffer {
    pub protocol_major: u16,
    pub protocol_minor: u16,
    pub peer: SidecarPeerIdentity,
    pub feature_bits: u64,
    pub limits: SidecarLimits,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NegotiatedSidecarProtocol {
    pub protocol_major: u16,
    pub protocol_minor: u16,
    pub feature_bits: u64,
    pub limits: SidecarLimits,
    pub remote_peer: SidecarPeerIdentity,
}

/// Negotiate additive features and limits without allowing either peer to
/// raise the other's local ceilings.
///
/// # Errors
///
/// Returns an error when roles or major versions are incompatible, or when
/// either peer offers an invalid limit or the local minor version is not
/// implemented.
pub fn negotiate_sidecar_protocol(
    local: &SidecarProtocolOffer,
    remote: &SidecarProtocolOffer,
) -> Result<NegotiatedSidecarProtocol, SidecarProtocolError> {
    let local_limits = local.limits.validate()?;
    let remote_limits = remote.limits.validate()?;

    if local.peer.role == remote.peer.role {
        return Err(SidecarProtocolError::InvalidPeerRole);
    }
    if local.feature_bits > SIDECAR_MAX_FEATURE_BITS
        || remote.feature_bits > SIDECAR_MAX_FEATURE_BITS
    {
        return Err(SidecarProtocolError::InvalidFeatureBits);
    }
    if local.protocol_major != SIDECAR_PROTOCOL_MAJOR
        || remote.protocol_major != SIDECAR_PROTOCOL_MAJOR
    {
        return Err(SidecarProtocolError::UnsupportedMajor {
            local: local.protocol_major,
            remote: remote.protocol_major,
        });
    }
    if local.protocol_minor > SIDECAR_PROTOCOL_MINOR {
        return Err(SidecarProtocolError::UnsupportedLocalMinor(
            local.protocol_minor,
        ));
    }

    Ok(NegotiatedSidecarProtocol {
        protocol_major: SIDECAR_PROTOCOL_MAJOR,
        protocol_minor: local.protocol_minor.min(remote.protocol_minor),
        feature_bits: local.feature_bits & remote.feature_bits,
        limits: SidecarLimits {
            max_frame_bytes: local_limits
                .max_frame_bytes
                .min(remote_limits.max_frame_bytes),
            max_in_flight: local_limits.max_in_flight.min(remote_limits.max_in_flight),
            bootstrap_timeout_ms: local_limits
                .bootstrap_timeout_ms
                .min(remote_limits.bootstrap_timeout_ms),
        },
        remote_peer: remote.peer.clone(),
    })
}

/// A fresh 256-bit key supplied out of band by the product supervisor.
pub struct SidecarSessionKey([u8; 32]);

impl SidecarSessionKey {
    #[must_use]
    pub const fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    /// Generate a fresh key using the operating system random source.
    ///
    /// # Errors
    ///
    /// Returns an error when the operating system random source is unavailable.
    pub fn generate() -> Result<Self, getrandom::Error> {
        let mut bytes = [0_u8; 32];
        getrandom::fill(&mut bytes)?;
        Ok(Self(bytes))
    }
}

impl fmt::Debug for SidecarSessionKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SidecarSessionKey([redacted])")
    }
}

impl Drop for SidecarSessionKey {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

/// Authenticates frames for exactly one process session and generation.
///
/// Create a new instance after every process restart. Sequence numbers are
/// directional and start at one. A rejected frame never advances the receive
/// high-water mark.
pub struct AuthenticatedSidecarChannel {
    instance_id: u64,
    role: SidecarPeerRole,
    protocol_minor: u16,
    session_id: String,
    generation: u64,
    key: SidecarSessionKey,
    max_frame_bytes: u32,
    frame_limit_locked: bool,
    send_sequence: u64,
    receive_sequence: u64,
    liveness: SidecarChannelLiveness,
    decoder: Option<JsonDecoder>,
}

#[derive(Clone)]
pub(crate) struct SidecarChannelLiveness(Arc<watch::Sender<bool>>);

impl SidecarChannelLiveness {
    pub(crate) fn is_retired(&self) -> bool {
        *self.0.borrow()
    }

    pub(crate) async fn retired(&self) {
        if self.is_retired() {
            return;
        }
        let mut receiver = self.0.subscribe();
        while !*receiver.borrow_and_update() {
            if receiver.changed().await.is_err() {
                return;
            }
        }
    }
}

impl AuthenticatedSidecarChannel {
    /// Create state for one role in one process-session generation.
    ///
    /// # Errors
    ///
    /// Returns an error for an empty or oversized session identifier, a zero
    /// generation, or an undersized frame limit.
    pub fn new(
        role: SidecarPeerRole,
        session_id: String,
        generation: u64,
        key: SidecarSessionKey,
        max_frame_bytes: u32,
    ) -> Result<Self, SidecarProtocolError> {
        if session_id.is_empty() || session_id.len() > usize::from(u16::MAX) {
            return Err(SidecarProtocolError::InvalidSessionId);
        }
        if generation == 0 {
            return Err(SidecarProtocolError::InvalidGeneration);
        }
        if (max_frame_bytes as usize) < minimum_frame_bytes(session_id.len()) {
            return Err(SidecarProtocolError::InvalidLimit("maxFrameBytes"));
        }
        let instance_id = NEXT_CHANNEL_INSTANCE_ID
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
                current.checked_add(1)
            })
            .map_err(|_| SidecarProtocolError::ChannelInstanceIdExhausted)?;

        Ok(Self {
            instance_id,
            role,
            protocol_minor: SIDECAR_BOOTSTRAP_MINOR,
            session_id,
            generation,
            key,
            max_frame_bytes,
            frame_limit_locked: false,
            send_sequence: 0,
            receive_sequence: 0,
            liveness: SidecarChannelLiveness(Arc::new(watch::channel(false).0)),
            decoder: None,
        })
    }

    /// Permanently retire this process-session channel.
    pub fn retire(&mut self) {
        self.key.0.zeroize();
        self.decoder = None;
        self.liveness.0.send_replace(true);
    }

    #[must_use]
    pub fn is_retired(&self) -> bool {
        self.liveness.is_retired()
    }

    pub(crate) fn liveness(&self) -> SidecarChannelLiveness {
        self.liveness.clone()
    }

    /// Return an opaque process-local identity for binding a state machine to
    /// this exact channel instance. The value has no wire or trust meaning.
    #[must_use]
    pub const fn instance_id(&self) -> u64 {
        self.instance_id
    }

    #[must_use]
    pub const fn role(&self) -> SidecarPeerRole {
        self.role
    }

    #[must_use]
    pub const fn max_frame_bytes(&self) -> u32 {
        self.max_frame_bytes
    }

    #[must_use]
    pub fn max_payload_bytes(&self) -> usize {
        self.max_frame_bytes as usize - FIXED_HEADER_BYTES - self.session_id.len() - AUTH_TAG_BYTES
    }

    /// Apply the negotiated frame ceiling without resetting channel sequence.
    ///
    /// # Errors
    ///
    /// Returns an error if the new limit cannot hold a minimal frame, would
    /// raise the ceiling used to bootstrap this channel, or configuration has
    /// locked the negotiated ceiling for the rest of the channel generation.
    pub fn lower_frame_limit(
        &mut self,
        negotiated_max_frame_bytes: u32,
    ) -> Result<(), SidecarProtocolError> {
        if self.frame_limit_locked {
            return Err(SidecarProtocolError::FrameLimitLocked);
        }
        if (negotiated_max_frame_bytes as usize) < minimum_frame_bytes(self.session_id.len()) {
            return Err(SidecarProtocolError::InvalidLimit("maxFrameBytes"));
        }
        if negotiated_max_frame_bytes > self.max_frame_bytes {
            return Err(SidecarProtocolError::LimitIncrease {
                current: self.max_frame_bytes,
                requested: negotiated_max_frame_bytes,
            });
        }
        self.max_frame_bytes = negotiated_max_frame_bytes;
        self.decoder = None;
        Ok(())
    }

    pub(crate) fn lock_frame_limit(&mut self) {
        self.frame_limit_locked = true;
    }

    /// Apply the authenticated protocol selection after the bootstrap exchange.
    ///
    /// Bootstrap frames always use minor zero so an older peer can read the
    /// offer. Both peers apply the independently verified selection only after
    /// the final bootstrap frame, without resetting directional sequence state.
    ///
    /// # Errors
    ///
    /// Returns an error if the selection is unsupported or would raise the
    /// channel's local frame ceiling.
    pub fn apply_negotiated_protocol(
        &mut self,
        negotiated: &NegotiatedSidecarProtocol,
    ) -> Result<(), SidecarProtocolError> {
        if negotiated.protocol_major != SIDECAR_PROTOCOL_MAJOR {
            return Err(SidecarProtocolError::UnsupportedMajor {
                local: SIDECAR_PROTOCOL_MAJOR,
                remote: negotiated.protocol_major,
            });
        }
        if negotiated.protocol_minor > SIDECAR_PROTOCOL_MINOR {
            return Err(SidecarProtocolError::UnsupportedLocalMinor(
                negotiated.protocol_minor,
            ));
        }
        self.lower_frame_limit(negotiated.limits.max_frame_bytes)?;
        self.protocol_minor = negotiated.protocol_minor;
        Ok(())
    }

    /// Serialize and authenticate the next outgoing payload.
    ///
    /// # Errors
    ///
    /// Returns an error when serialization fails, the encoded frame exceeds
    /// the local ceiling, the sequence has been exhausted, or the channel was
    /// retired by an inbound or transport failure.
    pub fn seal<T: Serialize>(&mut self, payload: &T) -> Result<Vec<u8>, SidecarFrameError> {
        let mut frame = Vec::new();
        self.seal_into(payload, &mut frame)?;
        Ok(frame)
    }

    /// Seal into a transport-owned buffer, reusing its allocation between completed writes.
    /// The buffer remains bounded by the channel ceiling and is empty on failure.
    ///
    /// # Errors
    ///
    /// Returns the same framing and serialization errors as [`Self::seal`].
    pub fn seal_into<T: Serialize>(
        &mut self,
        payload: &T,
        frame: &mut Vec<u8>,
    ) -> Result<(), SidecarFrameError> {
        frame.clear();
        if frame.capacity() > self.max_frame_bytes as usize {
            frame.shrink_to(self.max_frame_bytes as usize);
        }
        let result = self.seal_active(payload, frame);
        if result.is_err() {
            frame.clear();
        }
        result
    }

    fn seal_active<T: Serialize>(
        &mut self,
        payload: &T,
        frame: &mut Vec<u8>,
    ) -> Result<(), SidecarFrameError> {
        if self.is_retired() {
            return Err(SidecarFrameError::ChannelRetired);
        }
        let sequence = self
            .send_sequence
            .checked_add(1)
            .ok_or(SidecarFrameError::SequenceExhausted)?;
        let session_id = self.session_id.as_bytes();
        let minimum_capacity = FIXED_HEADER_BYTES
            .checked_add(session_id.len())
            .and_then(|size| size.checked_add(AUTH_TAG_BYTES))
            .ok_or(SidecarFrameError::FrameTooLarge {
                size: u64::MAX,
                limit: self.max_frame_bytes,
            })?;
        if minimum_capacity >= self.max_frame_bytes as usize {
            return Err(SidecarFrameError::FrameTooLarge {
                size: minimum_capacity.saturating_add(1) as u64,
                limit: self.max_frame_bytes,
            });
        }

        frame.reserve_exact(minimum_capacity);
        self.append_header(frame, FRAME_MAGIC, sequence, 0)?;

        let payload_start = frame.len();
        let max_authenticated_len = self.max_frame_bytes as usize - AUTH_TAG_BYTES;
        let serialization = {
            let mut writer = BoundedFrameWriter::new(frame, max_authenticated_len);
            match serde_json::to_writer(&mut writer, payload) {
                Ok(()) => Ok(()),
                Err(_) if writer.exceeded => Err(SidecarFrameError::FrameTooLarge {
                    size: u64::from(self.max_frame_bytes) + 1,
                    limit: self.max_frame_bytes,
                }),
                Err(error) => Err(SidecarFrameError::Serialize(error)),
            }
        };
        serialization?;

        let payload_len = u32::try_from(frame.len() - payload_start).map_err(|_| {
            SidecarFrameError::FrameTooLarge {
                size: u64::MAX,
                limit: self.max_frame_bytes,
            }
        })?;
        frame[PAYLOAD_LENGTH_OFFSET..PAYLOAD_LENGTH_OFFSET + 4]
            .copy_from_slice(&payload_len.to_be_bytes());

        let mut mac = HmacSha256::new_from_slice(&self.key.0)
            .map_err(|_| SidecarFrameError::Authentication)?;
        mac.update(frame);
        frame.extend_from_slice(&mac.finalize().into_bytes());
        self.send_sequence = sequence;
        Ok(())
    }

    fn append_header(
        &self,
        frame: &mut Vec<u8>,
        domain: [u8; 4],
        sequence: u64,
        payload_len: u32,
    ) -> Result<(), SidecarFrameError> {
        frame.extend_from_slice(&domain);
        frame.extend_from_slice(&SIDECAR_PROTOCOL_MAJOR.to_be_bytes());
        frame.extend_from_slice(&self.protocol_minor.to_be_bytes());
        frame.push(self.role.outgoing_direction().wire_value());
        frame.extend_from_slice(&self.generation.to_be_bytes());
        frame.extend_from_slice(&sequence.to_be_bytes());
        let session_len = u16::try_from(self.session_id.len())
            .map_err(|_| SidecarFrameError::InvalidSessionId)?;
        frame.extend_from_slice(&session_len.to_be_bytes());
        frame.extend_from_slice(&payload_len.to_be_bytes());
        frame.extend_from_slice(self.session_id.as_bytes());
        Ok(())
    }

    /// Authenticate borrowed segments under an explicitly negotiated private domain.
    /// OCSC remains UTF-8 JSON: callers cannot use its domain for opaque records.
    /// Returns only the header and tag; the caller writes those around the original
    /// segments and must retire the channel if that complete write fails.
    ///
    /// # Errors
    /// Returns an error for the reserved JSON domain, retirement, bounds, or sequence exhaustion.
    pub fn seal_opaque_parts(
        &mut self,
        domain: [u8; 4],
        payload: &[&[u8]],
    ) -> Result<(Vec<u8>, [u8; AUTH_TAG_BYTES]), SidecarFrameError> {
        if self.is_retired() {
            return Err(SidecarFrameError::ChannelRetired);
        }
        if domain == FRAME_MAGIC {
            return Err(SidecarFrameError::InvalidMagic);
        }
        let payload_limit = u32::try_from(self.max_payload_bytes())
            .map_err(|_| SidecarFrameError::InvalidFrameLimit(self.max_frame_bytes))?;
        let payload_len = parts_length(payload, payload_limit)?;
        let sequence = self
            .send_sequence
            .checked_add(1)
            .ok_or(SidecarFrameError::SequenceExhausted)?;
        let mut header = Vec::with_capacity(FIXED_HEADER_BYTES + self.session_id.len());
        self.append_header(&mut header, domain, sequence, payload_len)?;
        let mut mac = HmacSha256::new_from_slice(&self.key.0)
            .map_err(|_| SidecarFrameError::Authentication)?;
        mac.update(&header);
        for part in payload {
            mac.update(part);
        }
        self.send_sequence = sequence;
        Ok((header, mac.finalize().into_bytes().into()))
    }

    /// Authenticate, validate, and deserialize the next incoming frame.
    ///
    /// # Errors
    ///
    /// Returns an error for authentication, session, generation, direction,
    /// sequence, version, size, framing, or payload failures.
    pub fn open<T: DeserializeOwned>(&mut self, frame: &[u8]) -> Result<T, SidecarFrameError> {
        self.open_input(
            FrameInput::Borrowed(frame),
            |_| Ok(None),
            None,
            |_, _| unreachable!(),
        )
    }

    /// Decode using the transport's allocation instead of copying its authenticated payload.
    /// The frame bytes and allocation are returned unchanged, including on decoding failure.
    ///
    /// # Errors
    ///
    /// Returns the same authentication, framing, and JSON errors as [`Self::open`].
    pub fn open_reusing<T: DeserializeOwned>(
        &mut self,
        frame: &mut Vec<u8>,
    ) -> Result<T, SidecarFrameError> {
        self.open_reusing_with(frame, |_| Ok(None))
    }

    /// Decode an authenticated product message directly from the transport buffer.
    /// Return `None` to use the channel's reusable JSON decoder. A custom decoder
    /// must consume and validate the entire UTF-8 JSON payload before returning `Some`.
    /// It runs only after authentication and framing checks, before sequence advancement.
    ///
    /// # Errors
    ///
    /// Authentication, framing, and either decoder's errors permanently retire the channel.
    pub fn open_reusing_with<T: DeserializeOwned>(
        &mut self,
        frame: &mut Vec<u8>,
        decode: impl FnOnce(&[u8]) -> serde_json::Result<Option<T>>,
    ) -> Result<T, SidecarFrameError> {
        self.open_input(
            FrameInput::Reused(frame),
            decode,
            None,
            |_, _| unreachable!(),
        )
    }

    /// Open JSON or one explicitly negotiated opaque domain using the same authority.
    /// Both decoders run only after authentication and all channel header checks.
    /// The opaque decoder receives the payload and its range in the original frame;
    /// it must validate the entire product record before transferring that allocation.
    /// JSON records retain the same decoder contract as [`Self::open_reusing_with`].
    ///
    /// # Errors
    /// Any authentication, framing, or decoder error permanently retires the channel.
    pub fn open_reusing_with_opaque<T: DeserializeOwned>(
        &mut self,
        frame: &mut Vec<u8>,
        domain: [u8; 4],
        decode: impl FnOnce(&[u8]) -> serde_json::Result<Option<T>>,
        decode_opaque: impl FnOnce(&[u8], Range<usize>) -> Result<T, SidecarFrameError>,
    ) -> Result<T, SidecarFrameError> {
        self.open_input(
            FrameInput::Reused(frame),
            decode,
            Some(domain),
            decode_opaque,
        )
    }

    fn open_input<T: DeserializeOwned>(
        &mut self,
        frame: FrameInput<'_>,
        decode: impl FnOnce(&[u8]) -> serde_json::Result<Option<T>>,
        opaque_domain: Option<[u8; 4]>,
        decode_opaque: impl FnOnce(&[u8], Range<usize>) -> Result<T, SidecarFrameError>,
    ) -> Result<T, SidecarFrameError> {
        if self.is_retired() {
            return Err(SidecarFrameError::ChannelRetired);
        }

        let result = self.open_active(frame, decode, opaque_domain, decode_opaque);
        if result.is_err() {
            self.retire();
        }
        result
    }

    fn open_active<T: DeserializeOwned>(
        &mut self,
        input: FrameInput<'_>,
        decode: impl FnOnce(&[u8]) -> serde_json::Result<Option<T>>,
        opaque_domain: Option<[u8; 4]>,
        decode_opaque: impl FnOnce(&[u8], Range<usize>) -> Result<T, SidecarFrameError>,
    ) -> Result<T, SidecarFrameError> {
        let frame = input.as_ref();
        if frame.len() > self.max_frame_bytes as usize {
            return Err(SidecarFrameError::FrameTooLarge {
                size: frame.len() as u64,
                limit: self.max_frame_bytes,
            });
        }
        let minimum = FIXED_HEADER_BYTES + AUTH_TAG_BYTES;
        if frame.len() < minimum {
            return Err(SidecarFrameError::Truncated);
        }

        let authenticated_len = frame.len() - AUTH_TAG_BYTES;
        let (authenticated, supplied_tag) = frame.split_at(authenticated_len);
        let mut mac = HmacSha256::new_from_slice(&self.key.0)
            .map_err(|_| SidecarFrameError::Authentication)?;
        mac.update(authenticated);
        mac.verify_slice(supplied_tag)
            .map_err(|_| SidecarFrameError::Authentication)?;

        let mut cursor = 0;
        let magic = take::<4>(authenticated, &mut cursor)?;
        if magic != FRAME_MAGIC && Some(magic) != opaque_domain {
            return Err(SidecarFrameError::InvalidMagic);
        }
        let major = u16::from_be_bytes(take::<2>(authenticated, &mut cursor)?);
        let minor = u16::from_be_bytes(take::<2>(authenticated, &mut cursor)?);
        if major != SIDECAR_PROTOCOL_MAJOR || minor != self.protocol_minor {
            return Err(SidecarFrameError::UnsupportedVersion { major, minor });
        }
        let direction = SidecarDirection::from_wire(take::<1>(authenticated, &mut cursor)?[0])?;
        if direction != self.role.expected_remote().outgoing_direction() {
            return Err(SidecarFrameError::WrongDirection);
        }
        let generation = u64::from_be_bytes(take::<8>(authenticated, &mut cursor)?);
        if generation != self.generation {
            return Err(SidecarFrameError::WrongGeneration {
                expected: self.generation,
                received: generation,
            });
        }
        let sequence = u64::from_be_bytes(take::<8>(authenticated, &mut cursor)?);
        let expected_sequence = self
            .receive_sequence
            .checked_add(1)
            .ok_or(SidecarFrameError::SequenceExhausted)?;
        if sequence != expected_sequence {
            return Err(SidecarFrameError::UnexpectedSequence {
                expected: expected_sequence,
                received: sequence,
            });
        }
        let session_len = usize::from(u16::from_be_bytes(take::<2>(authenticated, &mut cursor)?));
        let payload_len =
            usize::try_from(u32::from_be_bytes(take::<4>(authenticated, &mut cursor)?))
                .map_err(|_| SidecarFrameError::Truncated)?;
        let session = take_slice(authenticated, &mut cursor, session_len)?;
        if session != self.session_id.as_bytes() {
            return Err(SidecarFrameError::WrongSession);
        }
        let payload_start = cursor;
        take_slice(authenticated, &mut cursor, payload_len)?;
        if cursor != authenticated.len() {
            return Err(SidecarFrameError::TrailingBytes);
        }

        let decoded = if magic == FRAME_MAGIC {
            match decode(&frame[payload_start..cursor]).map_err(SidecarFrameError::Deserialize)? {
                Some(decoded) => decoded,
                None => self
                    .decoder
                    .get_or_insert_with(JsonDecoder::new)
                    .decode(input, payload_start..cursor)
                    .map_err(SidecarFrameError::Deserialize)?,
            }
        } else {
            decode_opaque(&frame[payload_start..cursor], payload_start..cursor)?
        };
        self.receive_sequence = sequence;
        Ok(decoded)
    }
}

enum FrameInput<'a> {
    Borrowed(&'a [u8]),
    Reused(&'a mut Vec<u8>),
}

impl AsRef<[u8]> for FrameInput<'_> {
    fn as_ref(&self) -> &[u8] {
        match self {
            Self::Borrowed(bytes) => bytes,
            Self::Reused(bytes) => bytes,
        }
    }
}

// Keep serde's string scratch space for this authenticated channel. Recreating a
// slice decoder for every escaped media result doubles and discards a large buffer.
// The bounded input is replaced only after `end()` consumed the previous JSON document.
struct JsonDecoder {
    input: JsonInput,
    decoder: serde_json::Deserializer<serde_json::de::IoRead<BufReader<JsonInput>>>,
}

#[derive(Clone)]
struct JsonInput(Arc<Mutex<(Cursor<Vec<u8>>, usize)>>);

impl Read for JsonInput {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        let mut input = self.0.lock().unwrap();
        let (cursor, end) = &mut *input;
        // EOF is the authenticated JSON boundary, never the following HMAC or frame.
        let count = bytes.len().min(end.saturating_sub(
            usize::try_from(cursor.position()).expect("input position fits frame"),
        ));
        Read::read(cursor, &mut bytes[..count])
    }
}

impl JsonDecoder {
    fn new() -> Self {
        let input = JsonInput(Arc::new(Mutex::new((Cursor::new(Vec::new()), 0))));
        Self {
            decoder: serde_json::Deserializer::from_reader(BufReader::new(input.clone())),
            input,
        }
    }

    fn decode<T: DeserializeOwned>(
        &mut self,
        frame: FrameInput<'_>,
        range: Range<usize>,
    ) -> serde_json::Result<T> {
        let mut reused = None;
        {
            let mut input = self.input.0.lock().unwrap();
            let (cursor, end) = &mut *input;
            match frame {
                FrameInput::Borrowed(frame) => {
                    let payload = &frame[range];
                    let bytes = cursor.get_mut();
                    bytes.clear();
                    bytes.reserve_exact(payload.len());
                    bytes.extend_from_slice(payload);
                    cursor.set_position(0);
                    *end = payload.len();
                }
                FrameInput::Reused(frame) => {
                    std::mem::swap(cursor.get_mut(), frame);
                    cursor.set_position(range.start as u64);
                    *end = range.end;
                    reused = Some(frame);
                }
            }
        }
        let result = T::deserialize(&mut self.decoder).and_then(|value| {
            self.decoder.end()?;
            Ok(value)
        });
        // Restore the transport allocation before propagating any JSON error and retiring.
        let mut input = self.input.0.lock().unwrap();
        if let Some(frame) = reused {
            std::mem::swap(input.0.get_mut(), frame);
        } else {
            input.0.get_mut().clear();
        }
        result
    }
}

impl Drop for AuthenticatedSidecarChannel {
    fn drop(&mut self) {
        self.liveness.0.send_replace(true);
    }
}

const fn minimum_frame_bytes(session_id_bytes: usize) -> usize {
    FIXED_HEADER_BYTES + session_id_bytes + AUTH_TAG_BYTES + 1
}

struct BoundedFrameWriter<'a> {
    frame: &'a mut Vec<u8>,
    max_len: usize,
    exceeded: bool,
}

impl<'a> BoundedFrameWriter<'a> {
    const fn new(frame: &'a mut Vec<u8>, max_len: usize) -> Self {
        Self {
            frame,
            max_len,
            exceeded: false,
        }
    }
}

impl std::io::Write for BoundedFrameWriter<'_> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        let remaining = self.max_len.saturating_sub(self.frame.len());
        if bytes.len() > remaining {
            self.exceeded = true;
            return Err(std::io::Error::other("sidecar frame limit exceeded"));
        }
        // A large JSON fragment followed by a quote must not double the whole frame.
        // Include the tag in geometric growth, capped at the negotiated allocation ceiling.
        let required = self.frame.len() + bytes.len() + AUTH_TAG_BYTES;
        if required > self.frame.capacity() {
            let capacity = required
                .checked_next_power_of_two()
                .unwrap_or(usize::MAX)
                .min(self.max_len + AUTH_TAG_BYTES);
            self.frame.reserve_exact(capacity - self.frame.len());
        }
        self.frame.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn take<const N: usize>(bytes: &[u8], cursor: &mut usize) -> Result<[u8; N], SidecarFrameError> {
    let value = take_slice(bytes, cursor, N)?;
    value.try_into().map_err(|_| SidecarFrameError::Truncated)
}

fn take_slice<'a>(
    bytes: &'a [u8],
    cursor: &mut usize,
    length: usize,
) -> Result<&'a [u8], SidecarFrameError> {
    let end = cursor
        .checked_add(length)
        .ok_or(SidecarFrameError::Truncated)?;
    let value = bytes
        .get(*cursor..end)
        .ok_or(SidecarFrameError::Truncated)?;
    *cursor = end;
    Ok(value)
}

/// Read one length-prefixed frame while applying the local ceiling before
/// allocating the payload buffer.
///
/// # Errors
///
/// Returns an error for a zero or oversized frame, an I/O failure, or expiry
/// of the local deadline.
pub async fn read_sidecar_frame<R: AsyncRead + Unpin>(
    reader: &mut R,
    max_frame_bytes: u32,
    deadline: Duration,
) -> Result<Vec<u8>, SidecarFrameError> {
    if max_frame_bytes < MIN_FRAME_BYTES {
        return Err(SidecarFrameError::InvalidFrameLimit(max_frame_bytes));
    }
    let operation = async {
        let length = reader.read_u32().await.map_err(SidecarFrameError::Io)?;
        if length == 0 || length > max_frame_bytes {
            return Err(SidecarFrameError::FrameTooLarge {
                size: u64::from(length),
                limit: max_frame_bytes,
            });
        }
        let mut frame = vec![0_u8; length as usize];
        reader
            .read_exact(&mut frame)
            .await
            .map_err(SidecarFrameError::Io)?;
        Ok(frame)
    };
    tokio::time::timeout(deadline, operation)
        .await
        .map_err(|_| SidecarFrameError::Deadline)?
}

/// Write one bounded, length-prefixed frame within a local deadline.
///
/// # Errors
///
/// Returns an error for a zero or oversized frame, an I/O failure, or expiry
/// of the local deadline.
pub async fn write_sidecar_frame<W: AsyncWrite + Unpin>(
    writer: &mut W,
    frame: &[u8],
    max_frame_bytes: u32,
    deadline: Duration,
) -> Result<(), SidecarFrameError> {
    write_sidecar_frame_parts(writer, &[frame], max_frame_bytes, deadline).await
}

fn parts_length(parts: &[&[u8]], limit: u32) -> Result<u32, SidecarFrameError> {
    let length = parts
        .iter()
        .try_fold(0_u64, |length, part| length.checked_add(part.len() as u64))
        .unwrap_or(u64::MAX);
    if length == 0 || length > u64::from(limit) {
        return Err(SidecarFrameError::FrameTooLarge {
            size: length,
            limit,
        });
    }
    u32::try_from(length).map_err(|_| SidecarFrameError::FrameTooLarge {
        size: length,
        limit,
    })
}

/// Write borrowed segments as one length-prefixed frame with one whole-write deadline.
///
/// # Errors
/// Returns the same bounds, I/O, and deadline errors as [`write_sidecar_frame`].
pub async fn write_sidecar_frame_parts<W: AsyncWrite + Unpin>(
    writer: &mut W,
    parts: &[&[u8]],
    max_frame_bytes: u32,
    deadline: Duration,
) -> Result<(), SidecarFrameError> {
    if max_frame_bytes < MIN_FRAME_BYTES {
        return Err(SidecarFrameError::InvalidFrameLimit(max_frame_bytes));
    }
    let length = parts_length(parts, max_frame_bytes)?;
    let operation = async {
        writer
            .write_all(&length.to_be_bytes())
            .await
            .map_err(SidecarFrameError::Io)?;
        for part in parts {
            writer
                .write_all(part)
                .await
                .map_err(SidecarFrameError::Io)?;
        }
        writer.flush().await.map_err(SidecarFrameError::Io)
    };
    tokio::time::timeout(deadline, operation)
        .await
        .map_err(|_| SidecarFrameError::Deadline)?
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum SidecarProtocolError {
    #[error("sidecar channel instance id space exhausted")]
    ChannelInstanceIdExhausted,
    #[error("sidecar feature bits exceed the portable JSON integer range")]
    InvalidFeatureBits,
    #[error("sidecar peers must have complementary roles")]
    InvalidPeerRole,
    #[error("invalid sidecar limit: {0}")]
    InvalidLimit(&'static str),
    #[error("invalid sidecar session id")]
    InvalidSessionId,
    #[error("negotiated frame limit cannot increase from {current} to {requested}")]
    LimitIncrease { current: u32, requested: u32 },
    #[error("sidecar frame limit is locked for this configured channel")]
    FrameLimitLocked,
    #[error("sidecar generation must be nonzero")]
    InvalidGeneration,
    #[error("unsupported sidecar major version (local {local}, remote {remote})")]
    UnsupportedMajor { local: u16, remote: u16 },
    #[error("local sidecar minor version {0} is not implemented")]
    UnsupportedLocalMinor(u16),
}

#[derive(Debug, Error)]
pub enum SidecarFrameError {
    #[error("sidecar frame authentication failed")]
    Authentication,
    #[error("sidecar channel is retired")]
    ChannelRetired,
    #[error("sidecar frame deadline exceeded")]
    Deadline,
    #[error("sidecar frame length {size} exceeds local limit {limit}")]
    FrameTooLarge { size: u64, limit: u32 },
    #[error("invalid sidecar frame direction {0}")]
    InvalidDirection(u8),
    #[error("invalid sidecar frame magic")]
    InvalidMagic,
    #[error("invalid private sidecar record payload")]
    InvalidOpaquePayload,
    #[error("invalid local sidecar frame limit {0}")]
    InvalidFrameLimit(u32),
    #[error("invalid sidecar frame session id")]
    InvalidSessionId,
    #[error(
        "sidecar frame belongs to another generation (expected {expected}, received {received})"
    )]
    WrongGeneration { expected: u64, received: u64 },
    #[error("sidecar frame belongs to another session")]
    WrongSession,
    #[error("sidecar frame direction is invalid for this peer")]
    WrongDirection,
    #[error("sidecar sequence exhausted; rotate the generation")]
    SequenceExhausted,
    #[error("unexpected sidecar sequence (expected {expected}, received {received})")]
    UnexpectedSequence { expected: u64, received: u64 },
    #[error("sidecar frame is truncated")]
    Truncated,
    #[error("sidecar frame contains trailing bytes")]
    TrailingBytes,
    #[error("unsupported sidecar frame version {major}.{minor}")]
    UnsupportedVersion { major: u16, minor: u16 },
    #[error("sidecar payload serialization failed")]
    Serialize(#[source] serde_json::Error),
    #[error("sidecar payload deserialization failed")]
    Deserialize(#[source] serde_json::Error),
    #[error("sidecar transport failed")]
    Io(#[source] std::io::Error),
}

#[cfg(test)]
mod tests {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    use super::*;
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
    use serde::ser::SerializeSeq;
    use serde::Deserialize;
    use serde_json::{json, Value};
    use tokio::io::AsyncWriteExt;

    const KEY: [u8; 32] = [0x5a; 32];

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct WireFixture {
        schema_version: u8,
        session: WireSession,
        supervisor_probe: WireProbe,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct WireSession {
        id: String,
        generation: u64,
        session_key_base64: String,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct WireProbe {
        payload: Value,
        frame_base64: String,
    }

    struct CountingPayload {
        serialized: Arc<AtomicUsize>,
    }

    impl Serialize for CountingPayload {
        fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
        where
            S: serde::Serializer,
        {
            let mut sequence = serializer.serialize_seq(Some(1_000_000))?;
            for value in 0..1_000_000_u32 {
                self.serialized.fetch_add(1, Ordering::Relaxed);
                sequence.serialize_element(&value)?;
            }
            sequence.end()
        }
    }

    fn offer(role: SidecarPeerRole, limits: SidecarLimits) -> SidecarProtocolOffer {
        SidecarProtocolOffer {
            protocol_major: SIDECAR_PROTOCOL_MAJOR,
            protocol_minor: SIDECAR_PROTOCOL_MINOR,
            peer: SidecarPeerIdentity {
                role,
                name: match role {
                    SidecarPeerRole::Supervisor => "test-supervisor",
                    SidecarPeerRole::Runtime => "openclaw-node",
                }
                .into(),
                version: "1.0.0".into(),
                artifact_identity: "sha256:test-only".into(),
            },
            feature_bits: 0b0111,
            limits,
        }
    }

    fn channel(role: SidecarPeerRole, generation: u64) -> AuthenticatedSidecarChannel {
        AuthenticatedSidecarChannel::new(
            role,
            "session-7".into(),
            generation,
            SidecarSessionKey::from_bytes(KEY),
            4096,
        )
        .unwrap()
    }

    #[test]
    fn frame_limit_must_fit_the_specific_session_identifier() {
        let session_id = "longer-session-id";
        assert!(matches!(
            AuthenticatedSidecarChannel::new(
                SidecarPeerRole::Runtime,
                session_id.into(),
                1,
                SidecarSessionKey::from_bytes(KEY),
                MIN_FRAME_BYTES,
            ),
            Err(SidecarProtocolError::InvalidLimit("maxFrameBytes"))
        ));

        let exact_minimum = u32::try_from(minimum_frame_bytes(session_id.len())).unwrap();
        let mut channel = AuthenticatedSidecarChannel::new(
            SidecarPeerRole::Runtime,
            session_id.into(),
            1,
            SidecarSessionKey::from_bytes(KEY),
            exact_minimum,
        )
        .unwrap();
        assert_eq!(channel.max_payload_bytes(), 1);
        assert!(matches!(
            channel.lower_frame_limit(exact_minimum - 1),
            Err(SidecarProtocolError::InvalidLimit("maxFrameBytes"))
        ));
        assert_eq!(channel.seal(&0_u8).unwrap().len(), exact_minimum as usize);
    }

    #[test]
    fn shared_wire_fixture_is_byte_exact_and_decodable() {
        let fixture: WireFixture = serde_json::from_str(include_str!(
            "../../../test/fixtures/node-sidecar-protocol-v1.json"
        ))
        .unwrap();
        assert_eq!(fixture.schema_version, 1);
        let key: [u8; 32] = BASE64
            .decode(fixture.session.session_key_base64)
            .unwrap()
            .try_into()
            .unwrap();
        let expected_frame = BASE64
            .decode(fixture.supervisor_probe.frame_base64)
            .unwrap();

        let mut supervisor = AuthenticatedSidecarChannel::new(
            SidecarPeerRole::Supervisor,
            fixture.session.id.clone(),
            fixture.session.generation,
            SidecarSessionKey::from_bytes(key),
            4096,
        )
        .unwrap();
        assert_eq!(
            supervisor.seal(&fixture.supervisor_probe.payload).unwrap(),
            expected_frame
        );

        let mut runtime = AuthenticatedSidecarChannel::new(
            SidecarPeerRole::Runtime,
            fixture.session.id,
            fixture.session.generation,
            SidecarSessionKey::from_bytes(key),
            4096,
        )
        .unwrap();
        assert_eq!(
            runtime.open::<Value>(&expected_frame).unwrap(),
            fixture.supervisor_probe.payload
        );
    }

    #[test]
    fn negotiation_intersects_features_and_uses_lower_limits() {
        let local = offer(
            SidecarPeerRole::Supervisor,
            SidecarLimits {
                max_frame_bytes: 4096,
                max_in_flight: 8,
                bootstrap_timeout_ms: 2_000,
            },
        );
        let mut remote = offer(
            SidecarPeerRole::Runtime,
            SidecarLimits {
                max_frame_bytes: 2048,
                max_in_flight: 16,
                bootstrap_timeout_ms: 1_000,
            },
        );
        remote.feature_bits = 0b1011;

        let negotiated = negotiate_sidecar_protocol(&local, &remote).unwrap();
        assert_eq!(negotiated.feature_bits, 0b0011);
        assert_eq!(negotiated.limits.max_frame_bytes, 2048);
        assert_eq!(negotiated.limits.max_in_flight, 8);
        assert_eq!(negotiated.limits.bootstrap_timeout_ms, 1_000);
        assert_eq!(negotiated.remote_peer, remote.peer);
    }

    #[test]
    fn negotiation_rejects_unknown_major_and_same_role() {
        let limits = SidecarLimits {
            max_frame_bytes: 4096,
            max_in_flight: 8,
            bootstrap_timeout_ms: 1_000,
        };
        let local = offer(SidecarPeerRole::Supervisor, limits);
        let mut remote = offer(SidecarPeerRole::Runtime, limits);
        remote.protocol_major += 1;
        assert!(matches!(
            negotiate_sidecar_protocol(&local, &remote),
            Err(SidecarProtocolError::UnsupportedMajor { .. })
        ));

        let same_role = offer(SidecarPeerRole::Supervisor, limits);
        assert_eq!(
            negotiate_sidecar_protocol(&local, &same_role),
            Err(SidecarProtocolError::InvalidPeerRole)
        );

        let mut unsupported_local = local.clone();
        unsupported_local.protocol_minor += 1;
        assert_eq!(
            negotiate_sidecar_protocol(&unsupported_local, &remote),
            Err(SidecarProtocolError::UnsupportedMajor {
                local: SIDECAR_PROTOCOL_MAJOR,
                remote: SIDECAR_PROTOCOL_MAJOR + 1
            })
        );

        let compatible_remote = offer(SidecarPeerRole::Runtime, limits);
        assert_eq!(
            negotiate_sidecar_protocol(&unsupported_local, &compatible_remote),
            Err(SidecarProtocolError::UnsupportedLocalMinor(1))
        );
    }

    #[test]
    fn negotiation_rejects_feature_bits_that_json_cannot_preserve() {
        let limits = SidecarLimits {
            max_frame_bytes: 4096,
            max_in_flight: 8,
            bootstrap_timeout_ms: 1_000,
        };
        let mut local = offer(SidecarPeerRole::Supervisor, limits);
        let mut remote = offer(SidecarPeerRole::Runtime, limits);

        local.feature_bits = SIDECAR_MAX_FEATURE_BITS;
        remote.feature_bits = SIDECAR_MAX_FEATURE_BITS;
        assert_eq!(
            negotiate_sidecar_protocol(&local, &remote)
                .unwrap()
                .feature_bits,
            SIDECAR_MAX_FEATURE_BITS
        );

        remote.feature_bits += 1;
        assert_eq!(
            negotiate_sidecar_protocol(&local, &remote),
            Err(SidecarProtocolError::InvalidFeatureBits)
        );
    }

    #[test]
    fn shared_negotiation_fixture_preserves_features_above_32_bits() {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Fixture {
            schema_version: u8,
            local_offer: SidecarProtocolOffer,
            remote_offer: SidecarProtocolOffer,
            selected_feature_bits: u64,
        }

        let fixture: Fixture = serde_json::from_str(include_str!(
            "../../../test/fixtures/node-sidecar-negotiation-v1.json"
        ))
        .unwrap();
        assert_eq!(fixture.schema_version, 1);
        assert!(fixture.selected_feature_bits > u64::from(u32::MAX));
        assert_eq!(
            negotiate_sidecar_protocol(&fixture.local_offer, &fixture.remote_offer)
                .unwrap()
                .feature_bits,
            fixture.selected_feature_bits
        );
    }

    #[test]
    fn negotiated_limit_can_only_lower_an_active_channel() {
        let mut channel = channel(SidecarPeerRole::Supervisor, 7);
        channel.lower_frame_limit(2048).unwrap();
        assert_eq!(
            channel.lower_frame_limit(4096),
            Err(SidecarProtocolError::LimitIncrease {
                current: 2048,
                requested: 4096
            })
        );
        assert_eq!(
            channel.lower_frame_limit(MIN_FRAME_BYTES - 1),
            Err(SidecarProtocolError::InvalidLimit("maxFrameBytes"))
        );
    }

    #[test]
    fn authenticated_frame_round_trips_and_replay_fails_closed() {
        let mut supervisor = channel(SidecarPeerRole::Supervisor, 7);
        let mut runtime = channel(SidecarPeerRole::Runtime, 7);
        let frame = supervisor
            .seal(&json!({"type":"probe","requestId":"abc"}))
            .unwrap();

        let decoded: Value = runtime.open(&frame).unwrap();
        assert_eq!(decoded["requestId"], "abc");
        assert!(matches!(
            runtime.open::<Value>(&frame),
            Err(SidecarFrameError::UnexpectedSequence {
                expected: 2,
                received: 1
            })
        ));
    }

    #[test]
    fn negotiated_protocol_updates_active_header_without_resetting_sequence() {
        let local = offer(
            SidecarPeerRole::Supervisor,
            SidecarLimits {
                max_frame_bytes: 4096,
                max_in_flight: 8,
                bootstrap_timeout_ms: 1_000,
            },
        );
        let remote = offer(
            SidecarPeerRole::Runtime,
            SidecarLimits {
                max_frame_bytes: 2048,
                max_in_flight: 4,
                bootstrap_timeout_ms: 500,
            },
        );
        let negotiated = negotiate_sidecar_protocol(&local, &remote).unwrap();
        let mut supervisor = channel(SidecarPeerRole::Supervisor, 7);
        let mut runtime = channel(SidecarPeerRole::Runtime, 7);

        let bootstrap = supervisor.seal(&json!({"type":"offer"})).unwrap();
        assert_eq!(
            runtime.open::<Value>(&bootstrap).unwrap(),
            json!({"type":"offer"})
        );
        supervisor.apply_negotiated_protocol(&negotiated).unwrap();
        runtime.apply_negotiated_protocol(&negotiated).unwrap();

        let active = supervisor.seal(&json!({"type":"active"})).unwrap();
        assert_eq!(
            u16::from_be_bytes(active[6..8].try_into().unwrap()),
            negotiated.protocol_minor
        );
        assert_eq!(u64::from_be_bytes(active[17..25].try_into().unwrap()), 2);
        assert_eq!(
            runtime.open::<Value>(&active).unwrap(),
            json!({"type":"active"})
        );
    }

    #[test]
    fn a_large_json_fragment_keeps_frame_capacity_within_the_channel_limit() {
        let mut supervisor = channel(SidecarPeerRole::Supervisor, 7);
        let payload = json!({"media": "x".repeat(3 * 1024)});
        let frame = supervisor.seal(&payload).unwrap();
        assert!(frame.len() < supervisor.max_frame_bytes() as usize);
        assert!(
            frame.capacity() <= supervisor.max_frame_bytes() as usize,
            "JSON closing bytes must not double a near-limit frame allocation"
        );
        let mut runtime = channel(SidecarPeerRole::Runtime, 7);
        assert_eq!(runtime.open::<Value>(&frame).unwrap(), payload);
    }

    #[test]
    fn reused_frame_preserves_wire_sequence_and_discards_failed_output() {
        let mut supervisor = channel(SidecarPeerRole::Supervisor, 7);
        let mut runtime = channel(SidecarPeerRole::Runtime, 7);
        let large = json!({"media": "x".repeat(3 * 1024)});
        let small = json!({"ok": true});
        let mut frame = Vec::new();
        supervisor.seal_into(&large, &mut frame).unwrap();
        assert_eq!(runtime.open_reusing::<Value>(&mut frame).unwrap(), large);
        let allocation = frame.as_ptr();
        supervisor.seal_into(&small, &mut frame).unwrap();
        assert_eq!(frame.as_ptr(), allocation);
        assert_eq!(runtime.open_reusing::<Value>(&mut frame).unwrap(), small);

        assert!(supervisor.seal_into(&"x".repeat(4096), &mut frame).is_err());
        assert!(frame.is_empty());
        supervisor.seal_into(&large, &mut frame).unwrap();
        assert_eq!(frame.as_ptr(), allocation);
        assert_eq!(runtime.open_reusing::<Value>(&mut frame).unwrap(), large);

        supervisor.lower_frame_limit(128).unwrap();
        runtime.lower_frame_limit(128).unwrap();
        supervisor.seal_into(&small, &mut frame).unwrap();
        assert!(frame.capacity() <= 128);
        assert_eq!(runtime.open_reusing::<Value>(&mut frame).unwrap(), small);
        supervisor.retire();
        assert!(supervisor.seal_into(&small, &mut frame).is_err());
        assert!(frame.is_empty());
    }

    #[test]
    fn consecutive_documents_consume_the_entire_authenticated_payload() {
        for mode in 0..3 {
            let mut supervisor = channel(SidecarPeerRole::Supervisor, 7);
            let mut runtime = channel(SidecarPeerRole::Runtime, 7);
            for payload in [
                json!({"media": format!("\"{}\"", "x".repeat(3 * 1024))}),
                json!(123),
                json!(null),
                json!(["é🦀\n\\\"", true, -1.5]),
            ] {
                let mut frame = supervisor.seal(&payload).unwrap();
                let original = frame.clone();
                let allocation = frame.as_ptr();
                let decoded = match mode {
                    0 => runtime.open::<Value>(&frame),
                    1 => runtime.open_reusing::<Value>(&mut frame),
                    _ => runtime.open_reusing_with_opaque::<Value>(
                        &mut frame,
                        *b"TEST",
                        |_| Ok(None),
                        |_, _| panic!("OCSC must retain its JSON decoder"),
                    ),
                };
                assert_eq!(decoded.unwrap(), payload);
                assert_eq!(frame, original);
                assert_eq!(frame.as_ptr(), allocation);
            }

            for malformed in [b"0 1".as_slice(), b"01", b"{\"x\":\"\\q\"}", b"\"\xff\""] {
                let mut supervisor = channel(SidecarPeerRole::Supervisor, 7);
                let mut runtime = channel(SidecarPeerRole::Runtime, 7);
                let first = supervisor.seal(&json!({"ok":true})).unwrap();
                runtime.open::<Value>(&first).unwrap();
                let mut frame = supervisor.seal(&0).unwrap();
                frame.truncate(frame.len() - AUTH_TAG_BYTES - 1);
                frame[PAYLOAD_LENGTH_OFFSET..PAYLOAD_LENGTH_OFFSET + 4]
                    .copy_from_slice(&u32::try_from(malformed.len()).unwrap().to_be_bytes());
                frame.extend_from_slice(malformed);
                let mut mac = HmacSha256::new_from_slice(&KEY).unwrap();
                mac.update(&frame);
                frame.extend_from_slice(&mac.finalize().into_bytes());
                let original = frame.clone();
                let decoded = match mode {
                    0 => runtime.open::<Value>(&frame),
                    1 => runtime.open_reusing::<Value>(&mut frame),
                    _ => runtime.open_reusing_with_opaque::<Value>(
                        &mut frame,
                        *b"TEST",
                        |_| Ok(None),
                        |_, _| panic!("OCSC must retain its JSON decoder"),
                    ),
                };
                assert!(matches!(decoded, Err(SidecarFrameError::Deserialize(_))));
                assert_eq!(frame, original);
                assert!(runtime.is_retired());
                assert_eq!(runtime.receive_sequence, 1);
            }
        }
    }

    #[test]
    fn product_decoder_shares_authentication_sequence_and_retirement() {
        let mut supervisor = channel(SidecarPeerRole::Supervisor, 7);
        let mut runtime = channel(SidecarPeerRole::Runtime, 7);
        for custom in [false, true, false, true] {
            let payload = json!({"custom": custom, "media": "x".repeat(2048)});
            let mut frame = supervisor.seal(&payload).unwrap();
            let original = frame.clone();
            let allocation = frame.as_ptr();
            let decoded: Value = runtime
                .open_reusing_with(&mut frame, |bytes| {
                    if custom {
                        serde_json::from_slice(bytes).map(Some)
                    } else {
                        Ok(None)
                    }
                })
                .unwrap();
            assert_eq!(decoded, payload);
            assert_eq!(frame, original);
            assert_eq!(frame.as_ptr(), allocation);
        }
        let mut rejected = supervisor.seal(&json!({"custom": true})).unwrap();
        let original = rejected.clone();
        let failure = runtime.open_reusing_with::<Value>(&mut rejected, |_| {
            Err(serde::de::Error::custom("invalid product payload"))
        });
        assert!(matches!(failure, Err(SidecarFrameError::Deserialize(_))));
        assert_eq!(rejected, original);
        assert_eq!(runtime.receive_sequence, 4);
        assert!(runtime.is_retired());
        assert!(matches!(
            runtime.open_reusing_with::<Value>(&mut rejected, |_| {
                panic!("retired channel must not invoke product decoder")
            }),
            Err(SidecarFrameError::ChannelRetired)
        ));

        for failure in [
            "authentication",
            "generation",
            "direction",
            "sequence",
            "session",
        ] {
            let role = if failure == "direction" {
                SidecarPeerRole::Runtime
            } else {
                SidecarPeerRole::Supervisor
            };
            let mut sender = channel(role, if failure == "generation" { 6 } else { 7 });
            if failure == "session" {
                sender.session_id = "another-session".into();
            }
            if failure == "sequence" {
                sender.seal(&json!(null)).unwrap();
            }
            let mut frame = sender.seal(&json!({"custom":true})).unwrap();
            if failure == "authentication" {
                frame[FIXED_HEADER_BYTES] ^= 1;
            }
            let mut runtime = channel(SidecarPeerRole::Runtime, 7);
            assert!(runtime
                .open_reusing_with::<Value>(&mut frame, |_| {
                    panic!("{failure} must reject before product decoder")
                })
                .is_err());
            assert!(runtime.is_retired());
            assert_eq!(runtime.receive_sequence, 0);
        }
    }

    #[test]
    fn opaque_records_share_json_authority_without_relaxing_json() {
        let mut supervisor = channel(SidecarPeerRole::Supervisor, 7);
        let mut runtime = channel(SidecarPeerRole::Runtime, 7);
        let first = supervisor.seal(&json!({"control": 1})).unwrap();
        runtime.open::<Value>(&first).unwrap();
        let payload = b"\0\xffnot-json";
        assert!(matches!(
            supervisor.seal_opaque_parts(FRAME_MAGIC, &[payload]),
            Err(SidecarFrameError::InvalidMagic)
        ));
        assert!(supervisor
            .seal_opaque_parts(*b"TEST", &[&vec![0; 4096]])
            .is_err());
        let (header, tag) = supervisor
            .seal_opaque_parts(*b"TEST", &[&payload[..2], &payload[2..]])
            .unwrap();
        let mut frame = [header.as_slice(), payload, &tag].concat();
        assert!(matches!(
            channel(SidecarPeerRole::Runtime, 7).open::<Value>(&frame),
            Err(SidecarFrameError::InvalidMagic)
        ));
        let original = frame.clone();
        let decoded = runtime
            .open_reusing_with_opaque::<Value>(
                &mut frame,
                *b"TEST",
                |_| panic!("opaque bytes are not JSON"),
                |bytes, range| {
                    assert_eq!(bytes, payload);
                    assert_eq!(&original[range], payload);
                    Ok(json!("opaque"))
                },
            )
            .unwrap();
        assert_eq!(decoded, json!("opaque"));
        assert_eq!(frame, original);
        let next = supervisor.seal(&json!({"control": 3})).unwrap();
        assert_eq!(runtime.open::<Value>(&next).unwrap(), json!({"control": 3}));
        assert!(matches!(
            runtime.open_reusing_with_opaque::<Value>(
                &mut frame,
                *b"TEST",
                |_| panic!("replay"),
                |_, _| panic!("replay")
            ),
            Err(SidecarFrameError::UnexpectedSequence {
                expected: 4,
                received: 2
            })
        ));
        assert!(runtime.is_retired());
    }

    #[test]
    fn opaque_authentication_precedes_every_field_and_payload_decoder() {
        for failure in [
            "tag",
            "magic",
            "version",
            "direction",
            "generation",
            "sequence",
            "session",
            "length",
        ] {
            let mut sender = channel(SidecarPeerRole::Supervisor, 7);
            let (header, tag) = sender.seal_opaque_parts(*b"TEST", &[b"bytes"]).unwrap();
            let mut frame = [header.as_slice(), b"bytes", &tag].concat();
            let offset = match failure {
                "tag" => frame.len() - 1,
                "magic" => 0,
                "version" => 5,
                "direction" => 8,
                "generation" => 16,
                "sequence" => 24,
                "session" => FIXED_HEADER_BYTES,
                "length" => PAYLOAD_LENGTH_OFFSET + 3,
                _ => unreachable!(),
            };
            frame[offset] ^= 1;
            if failure == "direction" {
                frame[offset] = 2;
            }
            if failure != "tag" {
                let end = frame.len() - AUTH_TAG_BYTES;
                let mut mac = HmacSha256::new_from_slice(&KEY).unwrap();
                mac.update(&frame[..end]);
                frame[end..].copy_from_slice(&mac.finalize().into_bytes());
            }
            let mut receiver = channel(SidecarPeerRole::Runtime, 7);
            assert!(receiver
                .open_reusing_with_opaque::<Value>(
                    &mut frame,
                    *b"TEST",
                    |_| panic!("{failure}: JSON decoder ran"),
                    |_, _| panic!("{failure}: opaque decoder ran")
                )
                .is_err());
            assert!(receiver.is_retired());
            assert_eq!(receiver.receive_sequence, 0);
        }
        let mut sender = channel(SidecarPeerRole::Supervisor, 7);
        let (header, tag) = sender
            .seal_opaque_parts(*b"TEST", &[b"bad product record"])
            .unwrap();
        let mut frame = [header.as_slice(), b"bad product record", &tag].concat();
        let mut receiver = channel(SidecarPeerRole::Runtime, 7);
        assert!(matches!(
            receiver.open_reusing_with_opaque::<Value>(
                &mut frame,
                *b"TEST",
                |_| unreachable!(),
                |_, _| Err(SidecarFrameError::InvalidOpaquePayload)
            ),
            Err(SidecarFrameError::InvalidOpaquePayload)
        ));
        assert!(receiver.is_retired());
        assert_eq!(receiver.receive_sequence, 0);
    }

    #[tokio::test]
    async fn segmented_frame_covers_prefix_body_tag_eof_and_write_deadline() {
        let parts: &[&[u8]] = &[b"header", b"payload", b"tag"];
        let mut wire = Vec::new();
        write_sidecar_frame_parts(&mut wire, parts, 128, Duration::from_secs(1))
            .await
            .unwrap();
        let mut reader = wire.as_slice();
        assert_eq!(
            read_sidecar_frame(&mut reader, 128, Duration::from_secs(1))
                .await
                .unwrap(),
            b"headerpayloadtag"
        );
        for end in 0..wire.len() {
            let mut truncated = &wire[..end];
            assert!(
                matches!(read_sidecar_frame(&mut truncated, 128, Duration::from_secs(1)).await,
                Err(SidecarFrameError::Io(error)) if error.kind() == io::ErrorKind::UnexpectedEof)
            );
        }
        // Stall separately in the prefix, first segment, body, and tag. All use
        // the same whole-frame timeout, never a fresh budget for each segment.
        for capacity in [1, 4, 10, 17] {
            let (mut writer, _reader) = tokio::io::duplex(capacity);
            assert!(matches!(
                write_sidecar_frame_parts(&mut writer, parts, 128, Duration::from_millis(1)).await,
                Err(SidecarFrameError::Deadline)
            ));
        }
    }

    #[test]
    fn outbound_serialization_stops_at_frame_ceiling_without_advancing_sequence() {
        let serialized = Arc::new(AtomicUsize::new(0));
        let mut supervisor = AuthenticatedSidecarChannel::new(
            SidecarPeerRole::Supervisor,
            "session-7".into(),
            7,
            SidecarSessionKey::from_bytes(KEY),
            128,
        )
        .unwrap();
        let oversized = supervisor.seal(&CountingPayload {
            serialized: Arc::clone(&serialized),
        });
        assert!(matches!(
            oversized,
            Err(SidecarFrameError::FrameTooLarge {
                size: 129,
                limit: 128
            })
        ));
        assert!(serialized.load(Ordering::Relaxed) < 100);

        let frame = supervisor.seal(&json!({"ok":true})).unwrap();
        let mut runtime = AuthenticatedSidecarChannel::new(
            SidecarPeerRole::Runtime,
            "session-7".into(),
            7,
            SidecarSessionKey::from_bytes(KEY),
            128,
        )
        .unwrap();
        assert_eq!(runtime.open::<Value>(&frame).unwrap(), json!({"ok":true}));
    }

    #[test]
    fn authentication_failure_permanently_retires_channel() {
        let mut supervisor = channel(SidecarPeerRole::Supervisor, 7);
        let mut runtime = channel(SidecarPeerRole::Runtime, 7);
        let valid = supervisor.seal(&json!({"type":"probe"})).unwrap();
        let mut tampered = valid.clone();
        tampered[FIXED_HEADER_BYTES] ^= 1;

        assert!(matches!(
            runtime.open::<Value>(&tampered),
            Err(SidecarFrameError::Authentication)
        ));
        assert!(runtime.is_retired());
        assert!(matches!(
            runtime.open::<Value>(&valid),
            Err(SidecarFrameError::ChannelRetired)
        ));
        assert!(matches!(
            runtime.seal(&json!({"type":"status"})),
            Err(SidecarFrameError::ChannelRetired)
        ));
    }

    #[test]
    fn retired_generation_and_wrong_direction_are_rejected() {
        let mut old_supervisor = channel(SidecarPeerRole::Supervisor, 6);
        let mut current_runtime = channel(SidecarPeerRole::Runtime, 7);
        let old = old_supervisor.seal(&json!({"type":"probe"})).unwrap();
        assert!(matches!(
            current_runtime.open::<Value>(&old),
            Err(SidecarFrameError::WrongGeneration {
                expected: 7,
                received: 6
            })
        ));

        let mut another_supervisor = channel(SidecarPeerRole::Supervisor, 7);
        let outgoing = another_supervisor.seal(&json!({"type":"probe"})).unwrap();
        assert!(matches!(
            supervisor_open(&outgoing),
            Err(SidecarFrameError::WrongDirection)
        ));
    }

    fn supervisor_open(frame: &[u8]) -> Result<Value, SidecarFrameError> {
        channel(SidecarPeerRole::Supervisor, 7).open(frame)
    }

    #[tokio::test]
    async fn bounded_reader_rejects_length_before_payload_allocation() {
        let (mut writer, mut reader) = tokio::io::duplex(32);
        writer.write_all(&4097_u32.to_be_bytes()).await.unwrap();

        assert!(matches!(
            read_sidecar_frame(&mut reader, 4096, Duration::from_secs(1)).await,
            Err(SidecarFrameError::FrameTooLarge {
                size: 4097,
                limit: 4096
            })
        ));

        assert!(matches!(
            read_sidecar_frame(&mut reader, MIN_FRAME_BYTES - 1, Duration::from_secs(1)).await,
            Err(SidecarFrameError::InvalidFrameLimit(_))
        ));
    }

    #[tokio::test]
    async fn bounded_transport_round_trips_and_enforces_deadline() {
        let (mut writer, mut reader) = tokio::io::duplex(128);
        write_sidecar_frame(&mut writer, b"frame", 128, Duration::from_secs(1))
            .await
            .unwrap();
        assert_eq!(
            read_sidecar_frame(&mut reader, 128, Duration::from_secs(1))
                .await
                .unwrap(),
            b"frame"
        );

        assert!(matches!(
            read_sidecar_frame(&mut reader, 128, Duration::from_millis(1)).await,
            Err(SidecarFrameError::Deadline)
        ));
    }

    #[test]
    fn session_key_debug_is_redacted() {
        assert_eq!(
            format!("{:?}", SidecarSessionKey::from_bytes(KEY)),
            "SidecarSessionKey([redacted])"
        );
    }

    #[test]
    fn frame_prefix_constant_matches_wire_contract() {
        assert_eq!(LENGTH_PREFIX_BYTES, std::mem::size_of::<u32>());
        assert_eq!(
            MIN_FRAME_BYTES as usize,
            FIXED_HEADER_BYTES + AUTH_TAG_BYTES + 2
        );
    }
}
