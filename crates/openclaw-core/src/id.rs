use serde::{Deserialize, Serialize};
use std::fmt;
use std::str::FromStr;

macro_rules! newtype_id {
    ($name:ident, $prefix:literal) => {
        #[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(pub String);

        impl $name {
            #[must_use]
            pub fn new() -> Self {
                let raw = uuid::Uuid::new_v4();
                Self(format!("{}_{}", $prefix, raw.simple()))
            }

            #[must_use]
            pub fn from_raw(raw: impl Into<String>) -> Self {
                Self(raw.into())
            }

            #[must_use]
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self::new()
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }

        impl FromStr for $name {
            type Err = $crate::error::Error;

            fn from_str(s: &str) -> Result<Self, Self::Err> {
                Ok(Self(s.to_owned()))
            }
        }

        impl AsRef<str> for $name {
            fn as_ref(&self) -> &str {
                &self.0
            }
        }
    };
}

newtype_id!(AgentId, "agent");
newtype_id!(ChannelId, "chan");
newtype_id!(DeviceId, "dev");
newtype_id!(MessageId, "msg");
newtype_id!(SessionId, "ses");
newtype_id!(UserId, "usr");
