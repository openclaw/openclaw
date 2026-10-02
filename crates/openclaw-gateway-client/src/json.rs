use serde::Serialize;
use serde_json::Value;
use std::io;

/// Measure compact Gateway JSON without allocating an encoded payload.
/// Returns `None` once the serialized value exceeds `maximum` bytes.
#[must_use]
pub fn json_encoded_len(value: &Value, maximum: usize) -> Option<usize> {
    serialized_len(value, maximum).ok()
}

fn serialized_len<T: Serialize>(value: &T, maximum: usize) -> Result<usize, crate::ClientError> {
    let mut writer = LimitWriter {
        written: 0,
        maximum,
        exceeded: false,
    };
    serde_json::to_writer(&mut writer, value).map_err(|error| {
        if writer.exceeded {
            crate::ClientError::RequestTooLarge { maximum }
        } else {
            crate::ClientError::InvalidFrame(error.to_string())
        }
    })?;
    Ok(writer.written)
}

/// Typed requests keep their normalized values until this final encoding. A fixed
/// output slice also rejects serializers that exceed their measured length.
pub(crate) fn encode_bounded_json<T: Serialize>(
    value: &T,
    maximum: usize,
) -> Result<Vec<u8>, crate::ClientError> {
    let length = serialized_len(value, maximum)?;
    let mut bytes = vec![0; length];
    let mut writer = io::Cursor::new(bytes.as_mut_slice());
    serde_json::to_writer(&mut writer, value)
        .map_err(|error| crate::ClientError::InvalidFrame(error.to_string()))?;
    if writer.position() != length as u64 {
        return Err(crate::ClientError::InvalidFrame(
            "request serialization changed length".into(),
        ));
    }
    Ok(bytes)
}

struct LimitWriter {
    written: usize,
    maximum: usize,
    exceeded: bool,
}

impl io::Write for LimitWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let next = self
            .written
            .checked_add(bytes.len())
            .filter(|&size| size <= self.maximum)
            .ok_or_else(|| {
                self.exceeded = true;
                io::Error::other("serialized JSON exceeds byte limit")
            })?;
        self.written = next;
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn measured_json_matches_wire_bytes_and_exact_limits() {
        for value in [
            json!(null),
            json!(true),
            json!(18446744073709551615_u64),
            json!(-1.25),
            json!({"nested": ["\"\\\n\t\u{0000}é🦀", {"media": "x".repeat(3 * 1024)}]}),
        ] {
            let expected = value.to_string();
            assert_eq!(
                json_encoded_len(&value, expected.len()),
                Some(expected.len())
            );
            assert_eq!(json_encoded_len(&value, expected.len() - 1), None);
            assert_eq!(
                encode_bounded_json(&value, expected.len()).unwrap(),
                expected.as_bytes()
            );
            assert!(matches!(
                encode_bounded_json(&value, expected.len() - 1),
                Err(crate::ClientError::RequestTooLarge { .. })
            ));
        }
    }

    #[test]
    fn measurement_stops_at_limit_before_visiting_following_values() {
        struct MustNotVisit;
        impl Serialize for MustNotVisit {
            fn serialize<S: serde::Serializer>(&self, _: S) -> Result<S::Ok, S::Error> {
                Err(serde::ser::Error::custom(
                    "serializer visited beyond the frame limit",
                ))
            }
        }
        assert!(matches!(
            encode_bounded_json(&("x".repeat(32), MustNotVisit), 16),
            Err(crate::ClientError::RequestTooLarge { .. })
        ));
    }

    #[test]
    fn changing_serializer_cannot_grow_or_truncate_the_measured_frame() {
        use std::cell::Cell;
        struct ChangingPayload<'a> {
            first: Cell<bool>,
            values: [&'a str; 2],
        }
        impl Serialize for ChangingPayload<'_> {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.serialize_str(self.values[usize::from(!self.first.replace(false))])
            }
        }
        for values in [["x", "xxxx"], ["xxxx", "x"]] {
            assert!(matches!(
                encode_bounded_json(
                    &ChangingPayload {
                        first: Cell::new(true),
                        values
                    },
                    16
                ),
                Err(crate::ClientError::InvalidFrame(_))
            ));
        }
    }
}
