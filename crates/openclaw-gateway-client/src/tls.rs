use crate::TLS_PIN_MISMATCH_ERROR;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, WebPkiSupportedAlgorithms};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, Error as RustlsError, SignatureScheme};
use sha2::{Digest, Sha256};
use std::{
    fmt,
    sync::{Arc, Mutex},
};
use subtle::ConstantTimeEq;

#[derive(Default)]
pub(crate) struct CapturedTlsCertificate {
    pub certificate_chain: Vec<Vec<u8>>,
    pub ocsp_response: Vec<u8>,
}

enum CertificateTrust {
    Pinned([u8; 32]),
    Deferred(Arc<Mutex<CapturedTlsCertificate>>),
}

fn pinned_fingerprint_matches(expected: &[u8; 32], certificate_der: &[u8]) -> bool {
    let observed: [u8; 32] = Sha256::digest(certificate_der).into();
    bool::from(expected.as_slice().ct_eq(observed.as_slice()))
}

struct GatewayTlsVerifier {
    trust: CertificateTrust,
    supported_algorithms: WebPkiSupportedAlgorithms,
}

impl fmt::Debug for GatewayTlsVerifier {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GatewayTlsVerifier")
            .finish_non_exhaustive()
    }
}

impl ServerCertVerifier for GatewayTlsVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, RustlsError> {
        // A configured pin replaces CA/hostname trust, matching OpenClawKit. Signature checks
        // below still prove the peer owns the certificate's private key.
        match &self.trust {
            CertificateTrust::Pinned(expected) => {
                if !pinned_fingerprint_matches(expected, end_entity.as_ref()) {
                    return Err(RustlsError::General(TLS_PIN_MISMATCH_ERROR.to_string()));
                }
            }
            CertificateTrust::Deferred(captured) => {
                // The caller holds this stream private until native trust approves. Bound evidence
                // before copying it across IPC; signature verification below remains mandatory.
                let bytes = end_entity.len()
                    + ocsp_response.len()
                    + intermediates.iter().map(|cert| cert.len()).sum::<usize>();
                if bytes > 64 * 1024 {
                    return Err(RustlsError::General(
                        "Gateway TLS certificate chain exceeds limit".into(),
                    ));
                }
                let mut captured = captured
                    .lock()
                    .map_err(|_| RustlsError::General("Gateway TLS evidence unavailable".into()))?;
                captured.certificate_chain = std::iter::once(end_entity)
                    .chain(intermediates.iter())
                    .map(|cert| cert.as_ref().to_vec())
                    .collect();
                captured.ocsp_response = ocsp_response.to_vec();
            }
        }
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, RustlsError> {
        verify_tls12_signature(message, cert, signature, &self.supported_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, RustlsError> {
        verify_tls13_signature(message, cert, signature, &self.supported_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.supported_algorithms.supported_schemes()
    }
}

/// Build a rustls client configuration that trusts exactly one leaf-certificate fingerprint.
pub fn pinned_tls_config(expected: [u8; 32]) -> Result<ClientConfig, String> {
    tls_config(CertificateTrust::Pinned(expected))
}

pub(crate) fn deferred_tls_config(
    captured: Arc<Mutex<CapturedTlsCertificate>>,
) -> Result<ClientConfig, String> {
    let mut config = tls_config(CertificateTrust::Deferred(captured))?;
    // A resumed session can omit fresh certificate verification. Every native-policy attempt
    // must provide fresh evidence, and no early application data may precede its decision.
    config.resumption = rustls::client::Resumption::disabled();
    config.enable_early_data = false;
    Ok(config)
}

fn tls_config(trust: CertificateTrust) -> Result<ClientConfig, String> {
    let provider = rustls::crypto::ring::default_provider();
    let verifier = GatewayTlsVerifier {
        trust,
        supported_algorithms: provider.signature_verification_algorithms,
    };
    ClientConfig::builder_with_provider(Arc::new(provider))
        .with_safe_default_protocol_versions()
        .map_err(|error| format!("Could not configure Gateway TLS: {error}"))
        .map(|builder| {
            builder
                .dangerous()
                .with_custom_certificate_verifier(Arc::new(verifier))
                .with_no_client_auth()
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pin_verifier_matches_only_the_expected_certificate() {
        let certificate = b"fixture gateway leaf certificate";
        let expected: [u8; 32] = Sha256::digest(certificate).into();
        assert!(pinned_fingerprint_matches(&expected, certificate));
        assert!(!pinned_fingerprint_matches(
            &expected,
            b"different gateway leaf certificate"
        ));
        assert!(pinned_tls_config(expected).is_ok());
    }
}
