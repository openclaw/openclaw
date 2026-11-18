//! First launch reuses explicit local setup and returns failures to the setup page.
use crate::gateway::GatewaySnapshot;

pub(crate) fn eligible(
    configured: Result<bool, String>,
    has_profiles: impl FnOnce() -> Result<bool, String>,
) -> Result<bool, String> {
    if configured? {
        Ok(false)
    } else {
        has_profiles().map(|saved| !saved)
    }
}

pub(crate) fn complete(
    mut snapshot: GatewaySnapshot,
    fresh: Result<bool, String>,
    setup: impl FnOnce(bool) -> Result<GatewaySnapshot, String>,
) -> Result<GatewaySnapshot, String> {
    if !matches!(snapshot.phase, "missingCli" | "unconfigured") {
        return Ok(snapshot);
    }
    let result = match fresh {
        Ok(false) => return Ok(snapshot),
        Ok(true) => setup(snapshot.phase == "missingCli"),
        Err(error) => Err(error),
    };
    match result {
        Ok(ready) => Ok(ready),
        Err(error) => {
            snapshot.setup_error = Some(error);
            Ok(snapshot)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_absent_configuration_and_empty_saved_profiles_are_fresh() {
        for (configured, profiles, fresh) in [
            (false, false, true),
            (false, true, false),
            (true, false, false),
            (true, true, false),
        ] {
            assert_eq!(eligible(Ok(configured), || Ok(profiles)), Ok(fresh));
        }
        assert!(eligible(Ok(false), || Err("Credential store unavailable".into())).is_err());
        assert!(eligible(Err("Configuration unreadable".into()), || Ok(false)).is_err());
    }

    #[test]
    fn fresh_install_runs_local_setup_and_returns_its_dashboard() {
        for missing in [false, true] {
            let snapshot = if missing {
                GatewaySnapshot::missing_cli()
            } else {
                GatewaySnapshot::unconfigured()
            };
            let ready = complete(snapshot, Ok(true), |install| {
                assert_eq!(install, missing);
                let mut connected = GatewaySnapshot::unconfigured();
                connected.phase = "connected";
                Ok(connected)
            })
            .unwrap();
            assert_eq!(ready.phase, "connected");
        }
    }

    #[test]
    fn existing_configuration_or_profiles_keep_manual_setup() {
        let snapshot = complete(GatewaySnapshot::unconfigured(), Ok(false), |_| {
            panic!("existing setup must not install a local Gateway")
        })
        .unwrap();
        assert_eq!(snapshot.phase, "unconfigured");
        let remote = complete(GatewaySnapshot::remote_opening(), Ok(true), |_| {
            panic!("remote setup must not install a local Gateway")
        })
        .unwrap();
        assert_eq!(remote.phase, "remoteOpening");
    }

    #[test]
    fn install_failure_and_unreadable_saved_state_return_visible_manual_fallback() {
        for fresh in [Ok(true), Err("Saved Gateways unavailable".into())] {
            let snapshot = complete(GatewaySnapshot::missing_cli(), fresh, |_| {
                Err("Bundled runtime unavailable".into())
            })
            .unwrap();
            assert_eq!(snapshot.phase, "missingCli");
            assert!(matches!(
                snapshot.setup_error.as_deref(),
                Some("Bundled runtime unavailable" | "Saved Gateways unavailable")
            ));
        }
    }
}
