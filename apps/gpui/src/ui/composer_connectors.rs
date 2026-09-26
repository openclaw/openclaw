use super::*;
use gpui_kit::component::{
    WindowExt,
    input::{Input, InputState},
};

struct ConnectorForm {
    app: WeakEntity<AppView>,
    scope: Scope,
    generation: u64,
    name: Entity<InputState>,
    target: Entity<InputState>,
    transport: &'static str,
    session_only: bool,
    busy: bool,
    error: Option<String>,
    _connection: Subscription,
}

impl AppView {
    pub(super) fn open_composer_connector_dialog(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.composer_has_scope("operator.admin") {
            return;
        }
        self.composer_capabilities.plus_open = false;
        let scope = self.capability_scope();
        let generation = self.composer_capabilities.generation;
        self.composer_capabilities.scope = Some(scope.clone());
        let app = cx.entity().downgrade();
        let observed = cx.entity();
        let form = cx.new(|cx: &mut Context<ConnectorForm>| ConnectorForm {
            app,
            scope,
            generation,
            name: cx.new(|cx| InputState::new(window, cx).placeholder("context7")),
            target: cx
                .new(|cx| InputState::new(window, cx).placeholder("https://mcp.example.com/mcp")),
            transport: "streamable-http",
            session_only: true,
            busy: false,
            error: None,
            _connection:cx.observe(&observed,|form,app,cx|{
                let app=app.read(cx);
                if form.busy && !app.capability_is_current(&form.scope,form.generation) {
                    form.busy=false;
                    form.error=Some("Connection or session changed. Check connector settings before retrying; a save may already have completed.".into());
                    cx.notify();
                }
            }),
        });
        window.open_dialog(cx, move |dialog, _, cx| {
            let busy = form.read(cx).busy;
            let cancel = form.clone();
            dialog
                .title("Add MCP server")
                .w(px(tokens::CONNECTOR_DIALOG_WIDTH))
                .close_button(!busy)
                .overlay_closable(!busy)
                .child(form.clone())
                .on_cancel(move |_, _, cx| !cancel.read(cx).busy)
        });
        cx.notify();
    }

    fn save_composer_connector(
        &mut self,
        form: WeakEntity<ConnectorForm>,
        window: AnyWindowHandle,
        cx: &mut Context<Self>,
    ) {
        let Ok((scope, generation, name, transport, target, session_only)) =
            form.read_with(cx, |form, cx| {
                (
                    form.scope.clone(),
                    form.generation,
                    form.name.read(cx).value().trim().to_owned(),
                    form.transport,
                    form.target.read(cx).value().trim().to_owned(),
                    form.session_only,
                )
            })
        else {
            return;
        };
        if !self.capability_is_current(&scope, generation)
            || !self.composer_has_scope("operator.admin")
        {
            connector_error(
                &form,
                "Connection or session changed. Open Add MCP server again.".into(),
                cx,
            );
            return;
        }
        let mut config = match capabilities::connector_config(&name, transport, &target) {
            Ok(config) => config,
            Err(error) => {
                connector_error(&form, error, cx);
                return;
            }
        };
        if session_only {
            config["enabled"] = false.into();
        }
        self.request("config.get",json!({}),cx,move|this,result,cx| {
            if form.upgrade().is_none() {return;}
            if !this.capability_is_current(&scope,generation) || !this.composer_has_scope("operator.admin") {
                connector_error(&form,"Connection or session changed. No connector was added.".into(),cx);return;
            }
            let snapshot=match result {Ok(snapshot)=>snapshot,Err(error)=>{connector_error(&form,error,cx);return;}};
            let Some(hash)=snapshot.get("hash").and_then(Value::as_str) else {connector_error(&form,"Gateway configuration has no revision; reload before adding a server.".into(),cx);return;};
            if snapshot.pointer("/config/mcp/servers").and_then(|v|v.get(&name)).is_some() {
                connector_error(&form,"A server with that name already exists.".into(),cx);return;
            }
            let raw=json!({"mcp":{"servers":{name.clone():config}}}).to_string();
            this.request("config.patch",json!({"baseHash":hash,"raw":raw,"note":format!("composer connectors: add MCP server {name}")}),cx,move|this,result,cx| {
                if let Err(error)=result {connector_error(&form,error,cx);return;}
                if !this.capability_is_current(&scope,generation) || form.upgrade().is_none() {
                    connector_error(&form,"Server saved, but the session changed before it could be enabled.".into(),cx);return;
                }
                if !session_only {finish_connector(this,&form,window,cx);return;}
                if this.new_session.active {
                    let next=capabilities::next_boolean(this.current_tool_overrides(),"mcpServers",&name,true,false);
                    this.patch_composer_settings(json!({"toolOverrides":next}),cx,move|this,result,cx|match result {
                        Ok(())=>finish_connector(this,&form,window,cx),Err(error)=>connector_error(&form,format!("Server saved globally disabled, but session enable failed: {error}"),cx),
                    });
                    return;
                }
                this.request("sessions.describe",json!({"key":scope.session,"agentId":scope.agent}),cx,move|this,result,cx| {
                    if !this.capability_is_current(&scope,generation) || !this.composer_has_scope("operator.admin") || form.upgrade().is_none() {
                        connector_error(&form,"Server saved globally disabled. Session changed before it could be enabled.".into(),cx);return;
                    }
                    let row=match result.and_then(|value|value.get("session").cloned().ok_or_else(||"Session unavailable".to_owned())).and_then(|value|serde_json::from_value::<crate::model::sessions::SessionRow>(value).map_err(|e|e.to_string())) {
                        Ok(row)=>row,Err(error)=>{connector_error(&form,format!("Server saved globally disabled, but session reload failed: {error}"),cx);return;}
                    };
                    if row.session_id!=scope.incarnation {connector_error(&form,"Server saved globally disabled. Session identity changed.".into(),cx);return;}
                    let next=capabilities::next_boolean(row.tool_overrides.as_ref(),"mcpServers",&name,true,false);
                    this.patch_composer_settings(json!({"toolOverrides":next}),cx,move|this,result,cx|match result {
                        Ok(())=>finish_connector(this,&form,window,cx),Err(error)=>connector_error(&form,format!("Server saved globally disabled, but session enable failed: {error}"),cx),
                    });
                });
            });
        });
    }
}

fn connector_error(form: &WeakEntity<ConnectorForm>, error: String, cx: &mut Context<AppView>) {
    let _ = form.update(cx, |form, cx| {
        form.busy = false;
        form.error = Some(error);
        cx.notify();
    });
}
fn finish_connector(
    app: &mut AppView,
    form: &WeakEntity<ConnectorForm>,
    window: AnyWindowHandle,
    cx: &mut Context<AppView>,
) {
    if form.upgrade().is_some() {
        let _ = window.update(cx, |_, window, cx| window.close_dialog(cx));
        app.load_composer_capabilities(cx);
    }
}

impl Render for ConnectorForm {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = Palette::get(cx);
        let mut availability = div().h_flex().gap(px(tokens::FORM_ACTION_GAP));
        for (session_only, label) in [(true, "This session"), (false, "Everywhere")] {
            availability = availability.child(
                Button::new(if session_only {
                    "connector-session"
                } else {
                    "connector-everywhere"
                })
                .ghost()
                .small()
                .label(label)
                .when(self.session_only == session_only, |b| b.bg(p.hover))
                .disabled(self.busy)
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.session_only = session_only;
                    cx.notify();
                })),
            );
        }
        let mut transports = div().h_flex().gap(px(tokens::FORM_SEGMENT_GAP));
        for (transport, label) in [
            ("streamable-http", "HTTP"),
            ("sse", "SSE"),
            ("stdio", "stdio"),
        ] {
            transports = transports.child(
                Button::new(transport)
                    .ghost()
                    .small()
                    .label(label)
                    .disabled(self.busy)
                    .when(self.transport == transport, |b| b.bg(p.hover))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.transport = transport;
                        cx.notify();
                    })),
            );
        }
        div()
            .v_flex()
            .gap(px(tokens::FORM_GAP))
            .text_size(px(tokens::FORM_TEXT_SIZE))
            .child("Configure the server and choose where it is enabled.")
            .child("Availability")
            .child(availability)
            .child(
                div()
                    .text_size(px(tokens::DETAIL_TEXT_SIZE))
                    .text_color(p.muted)
                    .child(if self.session_only {
                        "The server is saved globally disabled and enabled only for this session."
                    } else {
                        "The server is saved and enabled for every session."
                    }),
            )
            .child("Name")
            .child(
                Input::new(&self.name)
                    .disabled(self.busy)
                    .aria_label("MCP server name"),
            )
            .child("Transport")
            .child(transports)
            .child("URL or command")
            .child(
                Input::new(&self.target)
                    .disabled(self.busy)
                    .aria_label("MCP server URL or command"),
            )
            .children(
                self.error
                    .as_ref()
                    .map(|error| div().text_color(p.danger).child(error.clone())),
            )
            .child(
                div()
                    .h_flex()
                    .justify_end()
                    .gap(px(tokens::FORM_ACTION_GAP))
                    .child(
                        Button::new("connector-add")
                            .primary()
                            .small()
                            .label(if self.busy { "Adding…" } else { "Add server" })
                            .disabled(self.busy)
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.busy = true;
                                this.error = None;
                                let form = cx.entity().downgrade();
                                let window = window.window_handle();
                                let _ = this.app.update(cx, |app, cx| {
                                    app.save_composer_connector(form, window, cx)
                                });
                                cx.notify();
                            })),
                    )
                    .child(
                        Button::new("connector-cancel")
                            .ghost()
                            .small()
                            .label("Cancel")
                            .disabled(self.busy)
                            .on_click(|_, window, cx| window.close_dialog(cx)),
                    ),
            )
    }
}
