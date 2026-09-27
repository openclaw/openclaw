use super::theme::Palette;
use super::theme::tokens::{radius, shell, space, text, weight};
use crate::gateway::{
    identity::Identity,
    profiles::{GatewayKind, GatewayProfile, ProfileCredentials, ProfileStore},
};
use gpui_kit::{
    component::{
        Disableable, Selectable, Sizable, StyledExt, TitleBar,
        button::{Button, ButtonVariants},
        input::{Input, InputState},
    },
    prelude::FluentBuilder,
    *,
};

pub struct GatewayManager {
    focus: FocusHandle,
    selected: Option<GatewayProfile>,
    profiles: Vec<GatewayProfile>,
    primary: Option<String>,
    name: Entity<InputState>,
    url: Entity<InputState>,
    target: Entity<InputState>,
    port: Entity<InputState>,
    identity: Entity<InputState>,
    token: Entity<InputState>,
    password: Entity<InputState>,
    ssh: bool,
    error: Option<String>,
    busy: bool,
    import: Option<GatewayProfile>,
    _activation: Subscription,
}

impl GatewayManager {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let store = ProfileStore::load();
        let profiles = store.as_ref().map(|s| s.list()).unwrap_or_default();
        let primary = store
            .as_ref()
            .ok()
            .and_then(|s| s.primary_id().map(str::to_owned));
        let input =
            |placeholder: &str, masked: bool, window: &mut Window, cx: &mut Context<Self>| {
                cx.new(|cx| {
                    InputState::new(window, cx)
                        .placeholder(placeholder)
                        .masked(masked)
                })
            };
        Self {
            focus: cx.focus_handle(),
            selected: None,
            import: if profiles.is_empty() {
                crate::gateway::profiles::mac_import_candidate()
            } else {
                None
            },
            profiles,
            primary,
            name: input("Gateway name", false, window, cx),
            url: input("https://gateway.example.com", false, window, cx),
            target: input("user@host[:port]", false, window, cx),
            port: cx.new(|cx| InputState::new(window, cx).default_value("18789")),
            identity: input("Optional: ~/.ssh/id_ed25519", false, window, cx),
            token: input("Optional Gateway token", true, window, cx),
            password: input("Optional Gateway password", true, window, cx),
            ssh: false,
            error: store.err(),
            busy: false,
            _activation: cx.observe_window_activation(window, |_, window, cx| {
                if window.is_window_active() {
                    crate::gateway_windows::focus(None, cx);
                }
            }),
        }
    }

    fn refresh(&mut self, cx: &mut Context<Self>) -> Result<(), String> {
        let store = ProfileStore::load()?;
        self.profiles = store.list();
        self.primary = store.primary_id().map(str::to_owned);
        crate::gateway_windows::reload(cx)?;
        cx.notify();
        Ok(())
    }

    fn edit(
        &mut self,
        profile: Option<GatewayProfile>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.busy {
            return;
        }
        let credentials = profile
            .as_ref()
            .and_then(|p| ProfileStore::load().ok().map(|s| s.credentials(&p.id)))
            .unwrap_or_default();
        let (url, target, port, identity) = match profile.as_ref().map(|p| &p.kind) {
            Some(GatewayKind::Ssh {
                target,
                remote_port,
                identity_file,
            }) => {
                self.ssh = true;
                (
                    String::new(),
                    target.clone(),
                    remote_port.to_string(),
                    identity_file.clone().unwrap_or_default(),
                )
            }
            kind => {
                self.ssh = false;
                (
                    if let Some(GatewayKind::Direct { url }) = kind {
                        url.clone()
                    } else {
                        String::new()
                    },
                    String::new(),
                    "18789".into(),
                    String::new(),
                )
            }
        };
        for (field, value) in [
            (
                &self.name,
                profile.as_ref().map(|p| p.name.clone()).unwrap_or_default(),
            ),
            (&self.url, url),
            (&self.target, target),
            (&self.port, port),
            (&self.identity, identity),
            (&self.token, credentials.token.unwrap_or_default()),
            (&self.password, credentials.password.unwrap_or_default()),
        ] {
            field.update(cx, |state, cx| state.set_value(value, window, cx));
        }
        self.selected = profile;
        self.error = None;
        self.name.update(cx, |state, cx| state.focus(window, cx));
        cx.notify();
    }

    fn save(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        let prepared = (|| {
            let kind = if self.ssh {
                GatewayKind::Ssh {
                    target: self.target.read(cx).value().to_string(),
                    remote_port: self
                        .port
                        .read(cx)
                        .value()
                        .trim()
                        .parse()
                        .map_err(|_| "Enter a remote Gateway port between 1 and 65535")?,
                    identity_file: Some(self.identity.read(cx).value().to_string()),
                }
            } else {
                GatewayKind::Direct {
                    url: self.url.read(cx).value().to_string(),
                }
            };
            let mut profile = GatewayProfile::new(self.name.read(cx).value().as_ref(), kind)?;
            let optional = |input: &Entity<InputState>| {
                let value = input.read(cx).value();
                (!value.trim().is_empty()).then(|| value.trim().to_owned())
            };
            let mut credentials = ProfileCredentials {
                token: optional(&self.token),
                password: optional(&self.password),
            };
            if credentials.token.is_some() && credentials.password.is_some() {
                return Err("Enter either a token or a password, not both".to_owned());
            }
            let store = ProfileStore::load()?;
            if store.list().iter().any(|p| {
                p.name.eq_ignore_ascii_case(&profile.name)
                    && self
                        .selected
                        .as_ref()
                        .is_none_or(|selected| p.id != selected.id)
            }) {
                return Err("A Gateway with this name already exists".into());
            }
            let replacement = self
                .selected
                .as_ref()
                .filter(|p| p.kind != profile.kind)
                .cloned();
            if let Some(previous) = &self.selected {
                if replacement.is_some() && credentials == store.credentials(&previous.id) {
                    credentials = ProfileCredentials::default();
                }
                profile.order = previous.order;
                if replacement.is_none() {
                    profile.id = previous.id.clone();
                }
            }
            Ok((profile, credentials, replacement))
        })();
        let (profile, credentials, replacement) = match prepared {
            Ok(prepared) => prepared,
            Err(error) => {
                self.error = Some(error);
                cx.notify();
                return;
            }
        };
        let was_open = self
            .selected
            .as_ref()
            .is_some_and(|previous| crate::gateway_windows::close_profile(&previous.id, cx));
        let primary = self
            .selected
            .as_ref()
            .is_some_and(|p| self.primary.as_deref() == Some(&p.id));
        self.busy = true;
        self.error = None;
        let executor = cx.background_executor().clone();
        cx.spawn_in(window, async move |this, cx| {
            let result = async {
                let mut store = ProfileStore::load()?;
                if let Some(previous) = replacement {
                    let removal = store.remove(&previous.id)?;
                    crate::web_data_store::remove_scopes(
                        &mut Identity::load()?,
                        &removal.web_scopes,
                        &executor,
                    )
                    .await?;
                }
                let profile = store.save_with_credentials(profile, primary, Some(credentials))?;
                Ok::<_, String>(profile)
            }
            .await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.busy = false;
                match result {
                    Ok(profile) => {
                        this.edit(Some(profile.clone()), window, cx);
                        this.import = None;
                        this.error = this.refresh(cx).err();
                        if was_open {
                            crate::gateway_windows::open_profile(profile, cx);
                        }
                    }
                    Err(error) => {
                        this.error = Some(error);
                        let _ = this.refresh(cx);
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn remove(&mut self, profile: GatewayProfile, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        crate::gateway_windows::close_profile(&profile.id, cx);
        self.busy = true;
        self.error = None;
        let executor = cx.background_executor().clone();
        cx.spawn_in(window, async move |this, cx| {
            let result = async {
                let removal = ProfileStore::load()?.remove(&profile.id)?;
                crate::web_data_store::remove_scopes(
                    &mut Identity::load()?,
                    &removal.web_scopes,
                    &executor,
                )
                .await
            }
            .await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.busy = false;
                this.edit(None, window, cx);
                this.error = result.err();
                if let Err(error) = this.refresh(cx) {
                    this.error = Some(error);
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn promote(&mut self, id: &str, cx: &mut Context<Self>) {
        self.error = ProfileStore::load()
            .and_then(|mut s| s.set_primary(id))
            .and_then(|_| self.refresh(cx))
            .err();
        cx.notify();
    }

    fn reorder(&mut self, index: usize, direction: isize, cx: &mut Context<Self>) {
        let other = index.saturating_add_signed(direction);
        if other >= self.profiles.len() || other == index {
            return;
        }
        let mut ids: Vec<_> = self.profiles.iter().map(|p| p.id.clone()).collect();
        ids.swap(index, other);
        self.error = ProfileStore::load()
            .and_then(|mut s| s.reorder(&ids))
            .and_then(|_| self.refresh(cx))
            .err();
        cx.notify();
    }
}

impl Render for GatewayManager {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if window.focused(cx).is_none() {
            self.focus.focus(window, cx);
        }
        let p = Palette::get(cx);
        let field = |label: &'static str, state: &Entity<InputState>| {
            div()
                .v_flex()
                .gap(space::REM_SM)
                .child(
                    div()
                        .text_size(text::WIDGET_SM_SIZE)
                        .text_color(p.muted)
                        .child(label),
                )
                .child(Input::new(state).aria_label(label).disabled(self.busy))
        };
        div().size_full().v_flex().track_focus(&self.focus).bg(p.bg).text_color(p.text)
            .on_action(cx.listener(|_, _: &crate::CloseWindow, window, _| window.remove_window()))
            .child(TitleBar::new().child("Manage Gateways"))
            .child(div().flex().flex_1().min_h_0()
                .child(div().id("gateway-list").v_flex().w(shell::GATEWAY_LIST_WIDTH).flex_shrink_0().bg(p.sidebar).border_r(space::HAIRLINE).border_color(p.border).p(space::REM_LG).gap(space::REM_MD).overflow_y_scroll()
                    .child(div().h_flex().justify_between().items_center().child(div().text_size(text::WIDGET_LG_SIZE).font_weight(weight::SEMIBOLD).child("Your Gateways"))
                        .child(Button::new("new-gateway").small().label("Add").disabled(self.busy).on_click(cx.listener(|this,_,window,cx| this.edit(None,window,cx)))))
                    .children(self.profiles.iter().enumerate().map(|(index,profile)| {
                        let edit = profile.clone(); let open = profile.clone(); let remove = profile.clone(); let primary_id = profile.id.clone();
                        let selected = self.selected.as_ref().is_some_and(|p| p.id == profile.id);
                        div().id(("saved-gateway",index)).v_flex().gap(space::REM_SM).p(space::REM_MD).rounded(radius::WIDGET_MD).bg(if selected {p.hover} else {p.card}).border(space::HAIRLINE).border_color(if selected {p.accent} else {p.border})
                            .child(Button::new(("edit-gateway",index)).ghost().label(format!("{}{}",profile.name,if self.primary.as_deref() == Some(&profile.id) {"  · Primary"} else {""})).disabled(self.busy).on_click(cx.listener(move |this,_,window,cx| this.edit(Some(edit.clone()),window,cx))))
                            .child(div().text_size(text::WIDGET_XS_SIZE).text_color(p.muted).child(match &profile.kind { GatewayKind::Direct{url}=>url.clone(), GatewayKind::Ssh{target,..}=>format!("{target} via SSH") }))
                            .child(div().h_flex().gap(space::REM_XS)
                                .child(Button::new(("open-gateway",index)).small().ghost().label("Open").disabled(self.busy).on_click(move |_,_,cx| crate::gateway_windows::open_profile(open.clone(),cx)))
                                .child(Button::new(("primary-gateway",index)).small().ghost().label("Primary").disabled(self.busy || self.primary.as_deref() == Some(&profile.id)).on_click(cx.listener(move |this,_,_,cx|this.promote(&primary_id,cx))))
                                .child(Button::new(("remove-gateway",index)).small().ghost().label("Remove").disabled(self.busy).on_click(cx.listener(move |this,_,window,cx|this.remove(remove.clone(),window,cx)))))
                            .child(div().h_flex().gap(space::REM_XS)
                                .child(Button::new(("up-gateway",index)).small().ghost().label("↑").disabled(self.busy || index <= 1 || self.primary.as_deref() == Some(&profile.id)).on_click(cx.listener(move |this,_,_,cx|this.reorder(index,-1,cx))))
                                .child(Button::new(("down-gateway",index)).small().ghost().label("↓").disabled(self.busy || index+1 == self.profiles.len() || self.primary.as_deref() == Some(&profile.id)).on_click(cx.listener(move |this,_,_,cx|this.reorder(index,1,cx)))))
                    }))
                    .when(self.profiles.is_empty(), |el| el.child(div().text_size(text::WIDGET_SM_SIZE).text_color(p.muted).child("Save a Gateway to open it from the menu bar."))))
                .child(div().id("gateway-editor").v_flex().flex_1().min_w_0().overflow_y_scroll().p(space::REM_XL).gap(space::REM_LG)
                    .child(div().text_size(text::WIDGET_XL_SIZE).font_weight(weight::SEMIBOLD).text_color(p.strong).child(if self.selected.is_some() {"Edit Gateway"} else {"Add Gateway"}))
                    .when_some(self.import.clone(), |el, profile| el.child(Button::new("import-mac").label("Import from OpenClaw for Mac").disabled(self.busy).on_click(cx.listener(move |this,_,window,cx| {
                        let result = ProfileStore::load().and_then(|mut store| store.save(profile.clone(),true));
                        match result { Ok(profile)=>{this.import=None; this.edit(Some(profile),window,cx); this.error=this.refresh(cx).err();}, Err(error)=>this.error=Some(error) }
                        cx.notify();
                    }))))
                    .child(field("Name",&self.name))
                    .child(div().h_flex().gap(space::REM_SM)
                        .child(Button::new("direct-kind").label("Direct URL").selected(!self.ssh).disabled(self.busy).on_click(cx.listener(|this,_,_,cx|{this.ssh=false;cx.notify();})))
                        .child(Button::new("ssh-kind").label("SSH tunnel").selected(self.ssh).disabled(self.busy).on_click(cx.listener(|this,_,_,cx|{this.ssh=true;cx.notify();}))))
                    .when(!self.ssh,|el|el.child(field("Gateway URL",&self.url)))
                    .when(self.ssh,|el|el.child(field("SSH target",&self.target)).child(field("Remote Gateway port",&self.port)).child(field("Identity file (optional)",&self.identity)))
                    .child(div().text_size(text::WIDGET_SM_SIZE).text_color(p.muted).child(if self.ssh {"Uses your existing SSH keys and known hosts. Matching remote config credentials or device pairing are used by default."} else {"Cloudflare Access sign-in opens from the Gateway window. Credentials below are optional."}))
                    .child(field("Token (optional)",&self.token)).child(field("Password (optional)",&self.password))
                    .when_some(self.error.clone(),|el,error|el.child(div().text_size(text::WIDGET_SM_SIZE).text_color(p.danger).child(error)))
                    .child(Button::new("save-gateway").primary().label(if self.busy {"Saving…"} else {"Save Gateway"}).disabled(self.busy).on_click(cx.listener(|this,_,window,cx|this.save(window,cx))))
                    .child(div().text_size(text::WIDGET_XS_SIZE).text_color(p.muted).child("Removing a Gateway closes its window and removes its saved credentials and web sessions. The primary Gateway opens at launch."))))
    }
}
