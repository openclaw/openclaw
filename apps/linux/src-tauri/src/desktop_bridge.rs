//! Same-user session-bus integration for a desktop panel. Gateway credentials stay
//! with GatewayClient; every operation is fenced by its selected route generation.
use crate::gateway_ws::{DesktopMethod, GatewayClient};
use crate::{quickchat, tray, DesktopState};
use serde_json::json;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use zbus::{fdo, message::Header};

const LEASE: Duration = Duration::from_secs(10);

struct Presenter {
    sender: String,
    generation: u64,
    renewed: Instant,
}

impl Presenter {
    fn is_current(&self, generation: u64, now: Instant) -> bool {
        self.generation == generation && now.duration_since(self.renewed) < LEASE
    }
}

struct Bridge {
    app: AppHandle,
    instance: String,
    presenter: Arc<Mutex<Option<Presenter>>>,
    last_read: Arc<Mutex<Option<Instant>>>,
}

impl Bridge {
    fn gateway(&self) -> tauri::State<'_, GatewayClient> {
        self.app.state::<GatewayClient>()
    }

    fn route_id(&self, generation: u64) -> String {
        format!("{}:{generation}", self.instance)
    }

    fn generation(&self, route_id: &str) -> fdo::Result<u64> {
        let (generation, _) = self.gateway().desktop_state();
        if route_id != self.route_id(generation) {
            return Err(fdo::Error::Failed(
                "Desktop Gateway changed; refresh before trying again.".into(),
            ));
        }
        Ok(generation)
    }
}

fn failed(message: String) -> fdo::Error {
    fdo::Error::Failed(message)
}

#[zbus::interface(name = "ai.openclaw.Desktop1")]
impl Bridge {
    fn get_state(&self) -> String {
        *self
            .last_read
            .lock()
            .expect("desktop demand mutex poisoned") = Some(Instant::now());
        self.gateway().set_desktop_demand(true);
        self.gateway().activate(self.app.clone());
        let (generation, ready) = self.gateway().desktop_state();
        json!({"version": 1, "routeId": self.route_id(generation), "ready": ready}).to_string()
    }

    async fn snapshot(&self, route_id: &str) -> fdo::Result<String> {
        let generation = self.generation(route_id)?;
        let gateway = self.gateway();
        let agents = gateway
            .desktop_request(generation, DesktopMethod::Agents, json!({}))
            .await
            .map_err(failed)?;
        let params = json!({"limit":40,"includeDerivedTitles":true,"includeLastMessage":true,"includeGlobal":true});
        let recent = gateway
            .desktop_request(generation, DesktopMethod::Sessions, params.clone())
            .await
            .map_err(failed)?;
        let mut active_params = params;
        active_params["activeOnly"] = json!(true);
        let active = gateway
            .desktop_request(generation, DesktopMethod::Sessions, active_params)
            .await
            .map_err(failed)?;
        self.generation(route_id)?;
        Ok(json!({"agents":agents,"recent":recent,"active":active}).to_string())
    }

    async fn send_prompt(
        &self,
        route_id: &str,
        agent_id: &str,
        session_key: &str,
        message: &str,
        idempotency_key: &str,
    ) -> fdo::Result<String> {
        let generation = self.generation(route_id)?;
        if message.trim().is_empty()
            || message.len() > 32_000
            || agent_id.is_empty()
            || agent_id.len() > 256
            || session_key.len() > 2048
            || idempotency_key.is_empty()
            || idempotency_key.len() > 256
        {
            return Err(fdo::Error::InvalidArgs(
                "Choose an agent and enter a prompt (up to 32,000 bytes).".into(),
            ));
        }
        let mut params =
            json!({"agentId":agent_id,"message":message,"idempotencyKey":idempotency_key});
        let method = if session_key.is_empty() {
            DesktopMethod::Create
        } else {
            // Canonical agent keys carry ownership; the raw global key needs
            // its separate agent owner.
            if session_key != "global" {
                params
                    .as_object_mut()
                    .expect("prompt params object")
                    .remove("agentId");
            }
            params["sessionKey"] = json!(session_key);
            params["deliver"] = json!(false);
            DesktopMethod::Send
        };
        let result = self
            .gateway()
            .desktop_request(generation, method, params)
            .await
            .map_err(failed)?;
        Ok(result.to_string())
    }

    fn claim_presenter(
        &self,
        route_id: &str,
        #[zbus(header)] header: Header<'_>,
    ) -> fdo::Result<()> {
        let generation = self.generation(route_id)?;
        let sender = header
            .sender()
            .ok_or_else(|| fdo::Error::AccessDenied("A session-bus sender is required.".into()))?
            .to_string();
        let mut presenter = self
            .presenter
            .lock()
            .expect("desktop presenter mutex poisoned");
        if presenter.as_ref().is_some_and(|current| {
            current.sender != sender && current.is_current(generation, Instant::now())
        }) {
            return Err(fdo::Error::Failed(
                "Another panel is presenting OpenClaw.".into(),
            ));
        }
        *presenter = Some(Presenter {
            sender,
            generation,
            renewed: Instant::now(),
        });
        Ok(())
    }

    async fn activate(
        &self,
        route_id: &str,
        action: &str,
        session_key: &str,
        agent_id: &str,
    ) -> fdo::Result<()> {
        let generation = self.generation(route_id)?;
        if !matches!(
            action,
            "dashboard" | "quickchat" | "session" | "updates" | "quit"
        ) || session_key.len() > 2048
            || agent_id.len() > 256
            || (action == "session"
                && (session_key.is_empty()
                    || (session_key == "global" && agent_id.trim().is_empty())))
        {
            return Err(fdo::Error::InvalidArgs(
                "Unknown desktop action or invalid session.".into(),
            ));
        }
        let app = self.app.clone();
        let action = action.to_string();
        let session_key = session_key.to_string();
        let agent_id = agent_id.to_string();
        let (reply, result) = tokio::sync::oneshot::channel();
        self.app
            .run_on_main_thread(move || {
                let gateway = app.state::<GatewayClient>();
                let outcome = gateway.with_desktop_route(generation, |ws_url| {
                    match action.as_str() {
                        "session" => {
                            let ws_url =
                                ws_url.ok_or("Select a Gateway in the desktop app first.")?;
                            let url = session_url(ws_url, &session_key, &agent_id)?;
                            crate::main_window(&app)?
                                .navigate(url)
                                .map_err(|e| e.to_string())?;
                            tray::show_window(&app);
                        }
                        "dashboard" => tray::show_window(&app),
                        "quickchat" => quickchat::toggle_quickchat(&app),
                        "updates" => {
                            tray::show_window(&app);
                            crate::updater::spawn_check(app.clone());
                        }
                        "quit" => {
                            app.state::<DesktopState>().quit();
                            app.exit(0);
                        }
                        _ => unreachable!(),
                    }
                    Ok(())
                });
                let _ = reply.send(outcome);
            })
            .map_err(|e| failed(e.to_string()))?;
        result
            .await
            .map_err(|_| failed("Desktop action interrupted.".into()))?
            .map_err(failed)
    }
}

fn session_url(ws_url: &str, session_key: &str, agent_id: &str) -> Result<tauri::Url, String> {
    let mut url = crate::remote_gateway::dashboard_url(
        &tauri::Url::parse(ws_url).map_err(|error| error.to_string())?,
    )?;
    url.set_query(None);
    url.set_fragment(None);
    {
        let mut path = url
            .path_segments_mut()
            .map_err(|_| "Gateway URL has no path")?;
        path.pop_if_empty().push("chat");
        if session_key == "global" {
            if agent_id.trim().is_empty() || matches!(agent_id, "." | "..") {
                return Err("Choose the global session's agent.".into());
            }
            // The shared URL contract maps raw global to the selected agent's
            // home route; agent:<id>:global is a distinct literal session.
            path.push(agent_id);
        }
    }
    if session_key != "global" {
        // Control UI bootstrap normalizes this shipped query contract.
        url.query_pairs_mut().append_pair("session", session_key);
    }
    Ok(url)
}

pub(crate) fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        if let Err(error) = run(app.clone()).await {
            eprintln!("Desktop panel bridge unavailable: {error}");
        }
        app.state::<GatewayClient>().set_desktop_demand(false);
        app.state::<DesktopState>()
            .with_tray(|tray| tray.set_visible(true));
    });
}

async fn run(app: AppHandle) -> zbus::Result<()> {
    let presenter = Arc::new(Mutex::new(None::<Presenter>));
    let last_read = Arc::new(Mutex::new(None::<Instant>));
    let bridge = Bridge {
        app: app.clone(),
        instance: uuid::Uuid::new_v4().to_string(),
        presenter: presenter.clone(),
        last_read: last_read.clone(),
    };
    let connection = zbus::connection::Builder::session()?
        .name("ai.openclaw.Desktop")?
        .serve_at("/ai/openclaw/Desktop", bridge)?
        .build()
        .await?;
    let bus = fdo::DBusProxy::new(&connection).await?;
    loop {
        tokio::time::sleep(Duration::from_secs(1)).await;
        let sender = presenter
            .lock()
            .expect("desktop presenter mutex poisoned")
            .as_ref()
            .map(|claim| claim.sender.clone());
        let owner_alive = match sender.as_deref() {
            Some(sender) => bus.name_has_owner(sender.try_into()?).await?,
            None => true,
        };
        let active = last_read
            .lock()
            .expect("desktop demand mutex poisoned")
            .is_some_and(|read| read.elapsed() < LEASE);
        app.state::<GatewayClient>().set_desktop_demand(active);
        let current_app = app.clone();
        let presenter = presenter.clone();
        app.run_on_main_thread(move || {
            let gateway = current_app.state::<GatewayClient>();
            let (generation, _) = gateway.desktop_state();
            // The bus lookup can overlap a new claim; do not apply an old sender's
            // liveness result to its replacement. The next tick checks the new owner.
            let mut claim = presenter.lock().expect("desktop presenter mutex poisoned");
            if claim.as_ref().map(|claim| claim.sender.as_str()) != sender.as_deref() {
                return;
            }
            let _ = gateway.with_desktop_route(generation, |_| {
                let hide = claim.as_ref().is_some_and(|claim| {
                    owner_alive && claim.is_current(generation, Instant::now())
                });
                if !hide {
                    *claim = None;
                }
                current_app
                    .state::<DesktopState>()
                    .with_tray(|tray| tray.set_visible(!hide));
                Ok(())
            });
        })
        .map_err(|error| zbus::Error::Failure(error.to_string()))?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_navigation_preserves_global_owner_and_qualified_literal_keys() {
        for (key, agent, expected) in [
            (
                "global",
                "builder",
                "https://gateway.example/control/chat/builder",
            ),
            (
                "agent:builder:global",
                "builder",
                "https://gateway.example/control/chat?session=agent%3Abuilder%3Aglobal",
            ),
            (
                "global",
                "builder/other",
                "https://gateway.example/control/chat/builder%2Fother",
            ),
        ] {
            assert_eq!(
                session_url("wss://gateway.example/control/", key, agent)
                    .unwrap()
                    .as_str(),
                expected
            );
        }
        assert!(session_url("ws://127.0.0.1/", "global", "").is_err());
    }

    #[test]
    fn presenter_lease_cannot_hide_a_replaced_route_or_outlive_its_deadline() {
        let now = Instant::now();
        let presenter = Presenter {
            sender: ":1.23".into(),
            generation: 4,
            renewed: now,
        };
        assert!(presenter.is_current(4, now + Duration::from_secs(9)));
        assert!(!presenter.is_current(5, now));
        assert!(!presenter.is_current(4, now + LEASE));
    }
}
