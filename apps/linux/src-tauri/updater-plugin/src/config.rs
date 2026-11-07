// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use std::{ffi::OsString, fmt::Display};

use serde::{Deserialize, Deserializer};
use url::Url;

/// Install modes for the Windows update.
#[derive(Debug, PartialEq, Eq, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[derive(Default)]
pub enum WindowsUpdateInstallMode {
    /// Specifies there's a basic UI during the installation process, including a final dialog box at the end.
    BasicUi,
    /// The quiet mode means there's no user interaction required.
    /// Requires admin privileges if the installer does.
    Quiet,
    /// Specifies unattended mode, which means the installation only shows a progress bar.
    #[default]
    Passive,
}

impl WindowsUpdateInstallMode {
    /// Returns the associated `msiexec.exe` arguments.
    pub fn msiexec_args(&self) -> &'static [&'static str] {
        match self {
            Self::BasicUi => &["/qb+"],
            Self::Quiet => &["/quiet"],
            Self::Passive => &["/passive"],
        }
    }

    #[cfg(windows)]
    pub(crate) fn msi_restart_after_install_args(&self) -> &'static [&'static str] {
        &["AUTOLAUNCHAPP=True"]
    }

    /// Returns the associated nsis arguments.
    pub fn nsis_args(&self) -> &'static [&'static str] {
        // `/P`: Passive
        // `/S`: Silent
        // `/R`: Restart
        match self {
            Self::Passive => &["/P"],
            Self::Quiet => &["/S"],
            _ => &[],
        }
    }

    #[cfg(windows)]
    pub(crate) fn nsis_restart_after_install_args(&self) -> &'static [&'static str] {
        match self {
            Self::BasicUi => &[],
            _ => &["/R"],
        }
    }
}

impl Display for WindowsUpdateInstallMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}",
            match self {
                Self::BasicUi => "basicUi",
                Self::Quiet => "quiet",
                Self::Passive => "passive",
            }
        )
    }
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WindowsConfig {
    /// Additional arguments given to the NSIS or WiX installer.
    ///
    /// Note: this applies to both WiX and NSIS installers
    #[serde(
        default,
        alias = "installer-args",
        deserialize_with = "deserialize_os_string"
    )]
    pub installer_args: Vec<OsString>,
    /// Updating mode, defaults to `passive` mode.
    ///
    /// See [`WindowsUpdateInstallMode`] for more info.
    #[serde(default, alias = "install-mode")]
    pub install_mode: WindowsUpdateInstallMode,
}

fn deserialize_os_string<'de, D>(deserializer: D) -> Result<Vec<OsString>, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(Vec::<String>::deserialize(deserializer)?
        .into_iter()
        .map(OsString::from)
        .collect::<Vec<_>>())
}

/// Updater configuration.
#[derive(Debug, Clone, Default)]
pub struct Config {
    /// Dangerously allow using insecure transport protocols for update endpoints.
    pub dangerous_insecure_transport_protocol: bool,
    /// Dangerously accept invalid TLS certificates for update requests.
    pub dangerous_accept_invalid_certs: bool,
    /// Dangerously accept invalid hostnames for TLS certificates for update requests.
    pub dangerous_accept_invalid_hostnames: bool,
    /// Updater endpoints.
    pub endpoints: Vec<Url>,
    /// Signature public key.
    pub pubkey: String,
    /// The Windows configuration for the updater.
    pub windows: Option<WindowsConfig>,
}

impl<'de> Deserialize<'de> for Config {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        pub struct Config {
            #[serde(default, alias = "dangerous-insecure-transport-protocol")]
            pub dangerous_insecure_transport_protocol: bool,
            #[serde(default, alias = "dangerous-accept-invalid-certs")]
            pub dangerous_accept_invalid_certs: bool,
            #[serde(default, alias = "dangerous-accept-invalid-hostnames")]
            pub dangerous_accept_invalid_hostnames: bool,
            #[serde(default)]
            pub endpoints: Vec<Url>,
            pub pubkey: String,
            pub windows: Option<WindowsConfig>,
        }

        let config = Config::deserialize(deserializer)?;

        validate_endpoints(
            &config.endpoints,
            config.dangerous_insecure_transport_protocol,
        )
        .map_err(serde::de::Error::custom)?;

        Ok(Self {
            dangerous_insecure_transport_protocol: config.dangerous_insecure_transport_protocol,
            dangerous_accept_invalid_certs: config.dangerous_accept_invalid_certs,
            dangerous_accept_invalid_hostnames: config.dangerous_accept_invalid_hostnames,
            endpoints: config.endpoints,
            pubkey: config.pubkey,
            windows: config.windows,
        })
    }
}

pub(crate) fn validate_endpoints(
    endpoints: &[Url],
    dangerous_insecure_transport_protocol: bool,
) -> crate::Result<()> {
    if !dangerous_insecure_transport_protocol {
        for url in endpoints {
            if url.scheme() != "https" {
                #[cfg(debug_assertions)]
                {
                    eprintln!("[\x1b[33mWARNING\x1b[0m] The updater endpoint \"{url}\" doesn't use `https` protocol. This is allowed in development but will fail in release builds.");
                    eprintln!("[\x1b[33mWARNING\x1b[0m] if this is a desired behavior, you can enable `dangerousInsecureTransportProtocol` in the plugin configuration");
                }
                #[cfg(not(debug_assertions))]
                return Err(crate::Error::InsecureTransportProtocol);
            }
        }
    }

    Ok(())
}
