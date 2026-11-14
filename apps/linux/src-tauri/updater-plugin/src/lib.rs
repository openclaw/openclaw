// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

//! In-app updates for Tauri applications.
//!
//! Supported platforms: Windows, Linux and macOS.
//!
//! ## Cargo features
//!
//! - **zip** *(enabled by default)*: Adds support for compressed updater bundles from Tauri v1.
//! - **rustls-tls** *(enabled by default)*: Enables TLS functionality provided by `rustls`.
//! - **native-tls**: Enables TLS functionality provided by `native-tls`.
//! - **native-tls-vendored**: Enables the `vendored` feature of `native-tls`.
//! - **system-proxy** *(enabled by default)*: Use Windows and macOS system proxy settings automatically.

#![doc(
    html_logo_url = "https://github.com/tauri-apps/tauri/raw/dev/app-icon.png",
    html_favicon_url = "https://github.com/tauri-apps/tauri/raw/dev/app-icon.png"
)]

use std::{ffi::OsString, sync::Arc};

use http::{HeaderMap, HeaderName, HeaderValue};
use semver::Version;
use tauri::{
    plugin::{Builder as PluginBuilder, TauriPlugin},
    Manager, Runtime,
};

mod commands;
mod config;
mod error;
mod updater;

pub use config::Config;
pub use error::{Error, Result};
pub use updater::*;

/// Extensions to [`tauri::App`], [`tauri::AppHandle`], [`tauri::WebviewWindow`], [`tauri::Webview`] and [`tauri::Window`] to access the updater APIs.
pub trait UpdaterExt<R: Runtime> {
    /// Gets the updater builder to build and updater
    /// that can manually check if an update is available.
    ///
    /// # Examples
    ///
    /// ```no_run
    /// use tauri_plugin_updater::UpdaterExt;
    /// tauri::Builder::default()
    ///   .setup(|app| {
    ///     let handle = app.handle().clone();
    ///     tauri::async_runtime::spawn(async move {
    ///         let response = handle.updater_builder().build().unwrap().check().await;
    ///     });
    ///     Ok(())
    ///   });
    /// ```
    fn updater_builder(&self) -> UpdaterBuilder;

    /// Gets the updater to manually check if an update is available.
    ///
    /// # Examples
    ///
    /// ```no_run
    /// use tauri_plugin_updater::UpdaterExt;
    /// tauri::Builder::default()
    ///   .setup(|app| {
    ///     let handle = app.handle().clone();
    ///     tauri::async_runtime::spawn(async move {
    ///         let response = handle.updater().unwrap().check().await;
    ///     });
    ///     Ok(())
    ///   });
    /// ```
    fn updater(&self) -> Result<Updater>;
}

impl<R: Runtime, T: Manager<R>> UpdaterExt<R> for T {
    fn updater_builder(&self) -> UpdaterBuilder {
        let app = self.app_handle();
        let UpdaterState {
            config,
            target,
            version_comparator,
            headers,
        } = self.state::<UpdaterState>().inner();

        let mut builder = UpdaterBuilder::new(app, config.clone()).headers(headers.clone());

        if let Some(target) = target {
            builder = builder.target(target);
        }

        #[cfg(windows)]
        {
            builder = builder.current_exe_args(self.env().args_os);
        }

        builder.version_comparator = version_comparator.clone();

        #[cfg(any(
            target_os = "linux",
            target_os = "dragonfly",
            target_os = "freebsd",
            target_os = "netbsd",
            target_os = "openbsd"
        ))]
        {
            let env = app.env();
            if let Some(appimage) = env.appimage {
                builder = builder.executable_path(appimage);
            }
        }

        let app_handle = app.app_handle().clone();
        builder = builder.on_before_exit(move || {
            app_handle.cleanup_before_exit();
        });

        builder
    }

    fn updater(&self) -> Result<Updater> {
        self.updater_builder().build()
    }
}

struct UpdaterState {
    target: Option<String>,
    config: Config,
    version_comparator: Option<VersionComparator>,
    headers: HeaderMap,
}

#[derive(Default)]
pub struct Builder {
    target: Option<String>,
    pubkey: Option<String>,
    installer_args: Vec<OsString>,
    headers: HeaderMap,
    default_version_comparator: Option<VersionComparator>,
}

impl Builder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn target(mut self, target: impl Into<String>) -> Self {
        self.target.replace(target.into());
        self
    }

    pub fn pubkey<S: Into<String>>(mut self, pubkey: S) -> Self {
        self.pubkey.replace(pubkey.into());
        self
    }

    /// Adds an additional argument to pass to the Windows installer.
    pub fn installer_args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        self.installer_args.extend(args.into_iter().map(Into::into));
        self
    }

    /// Adds multiple additional arguments to pass to the Windows installer.
    pub fn installer_arg<S>(mut self, arg: S) -> Self
    where
        S: Into<OsString>,
    {
        self.installer_args.push(arg.into());
        self
    }

    /// Removes all the additional arguments to pass to the Windows installer.
    ///
    /// Note: this only removes the additional arguments added through [`Self::installer_args`],
    /// not the ones managed by us (e.g. `/UPDATER` flag passed to the NSIS installer)
    pub fn clear_installer_args(mut self) -> Self {
        self.installer_args.clear();
        self
    }

    pub fn header<K, V>(mut self, key: K, value: V) -> Result<Self>
    where
        HeaderName: TryFrom<K>,
        <HeaderName as TryFrom<K>>::Error: Into<http::Error>,
        HeaderValue: TryFrom<V>,
        <HeaderValue as TryFrom<V>>::Error: Into<http::Error>,
    {
        let key: std::result::Result<HeaderName, http::Error> = key.try_into().map_err(Into::into);
        let value: std::result::Result<HeaderValue, http::Error> =
            value.try_into().map_err(Into::into);
        self.headers.insert(key?, value?);

        Ok(self)
    }

    pub fn headers(mut self, headers: HeaderMap) -> Self {
        self.headers = headers;
        self
    }

    pub fn default_version_comparator<
        F: Fn(Version, RemoteRelease) -> bool + Send + Sync + 'static,
    >(
        mut self,
        f: F,
    ) -> Self {
        self.default_version_comparator.replace(Arc::new(f));
        self
    }

    pub fn build<R: Runtime>(self) -> TauriPlugin<R, Config> {
        let pubkey = self.pubkey;
        let target = self.target;
        let version_comparator = self.default_version_comparator;
        let installer_args = self.installer_args;
        let headers = self.headers;
        PluginBuilder::<R, Config>::new("updater")
            .setup(move |app, api| {
                let mut config = api.config().clone();
                if let Some(pubkey) = pubkey {
                    config.pubkey = pubkey;
                }
                if let Some(windows) = &mut config.windows {
                    windows.installer_args.extend(installer_args);
                }
                app.manage(UpdaterState {
                    target,
                    config,
                    version_comparator,
                    headers,
                });
                Ok(())
            })
            .invoke_handler(tauri::generate_handler![
                commands::check,
                commands::download,
                commands::install,
                commands::download_and_install,
            ])
            .build()
    }
}
