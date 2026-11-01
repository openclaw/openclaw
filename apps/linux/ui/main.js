const nativeI18nReady = window["__OPENCLAW_TAURI_I18N_READY__"];
const shellI18n = nativeI18nReady
  ? await nativeI18nReady
  : {
      locale: "en",
      text: (_key, args = {}, fallback = _key) =>
        fallback.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/gu, (token, name) =>
          Object.hasOwn(args, name) ? String(args[name]) : token,
        ),
    };
const t = (key, fallback, args = {}) => shellI18n.text(key, args, fallback);
const tauri = window["__TAURI__"];
const { invoke } = tauri.core;
const { listen } = tauri.event;

const elements = {
  activity: document.querySelector("#activity"),
  activityLabel: document.querySelector("#activity-label"),
  actionControls: document.querySelector("#action-controls"),
  channel: document.querySelector("#channel"),
  channelLabel: document.querySelector("#channel-label"),
  channelField: document.querySelector("#channel-field"),
  bundledInstall: document.querySelector("#bundled-install"),
  connectionChoices: document.querySelector("#connection-choices"),
  connectionLocal: document.querySelector("#connection-local"),
  connectionRemote: document.querySelector("#connection-remote"),
  description: document.querySelector("#description"),
  discovery: document.querySelector("#discovery"),
  eyebrow: document.querySelector("#eyebrow"),
  footerMode: document.querySelector("#footer-mode"),
  gatewayList: document.querySelector("#gateway-list"),
  discoveryStatus: document.querySelector("#discovery-status"),
  editConnection: document.querySelector("#edit-connection"),
  installButton: document.querySelector("#install-button"),
  installControls: document.querySelector("#install-controls"),
  installHint: document.querySelector("#install-hint"),
  installLog: document.querySelector("#install-log"),
  logStatus: document.querySelector("#log-status"),
  logWrap: document.querySelector("#log-wrap"),
  localSubtitle: document.querySelector("#local-subtitle"),
  primaryAction: document.querySelector("#primary-action"),
  remoteAuthMethod: document.querySelector("#remote-auth-method"),
  remoteCredentialHint: document.querySelector("#remote-credential-hint"),
  remoteCredentialToggle: document.querySelector("#toggle-remote-credential"),
  remoteConnect: document.querySelector("#remote-connect"),
  remoteDetails: document.querySelector("#remote-details"),
  remoteFeedback: document.querySelector("#remote-feedback"),
  remotePassword: document.querySelector("#remote-password"),
  remotePasswordField: document.querySelector("#remote-password-field"),
  remotePort: document.querySelector("#remote-port"),
  remoteSshField: document.querySelector("#remote-ssh-field"),
  remoteSshTarget: document.querySelector("#remote-ssh-target"),
  remoteSubtitle: document.querySelector("#remote-subtitle"),
  remoteToken: document.querySelector("#remote-token"),
  remoteTokenField: document.querySelector("#remote-token-field"),
  remoteTransportDirect: document.querySelector("#remote-transport-direct"),
  remoteTransportSsh: document.querySelector("#remote-transport-ssh"),
  remoteUrl: document.querySelector("#remote-url"),
  remoteUrlField: document.querySelector("#remote-url-field"),
  runtimeFlavor: document.querySelector("#runtime-flavor"),
  runtimeSeparator: document.querySelector("#runtime-separator"),
  setupBack: document.querySelector("#setup-back"),
  setupContinue: document.querySelector("#setup-continue"),
  setupNavigation: document.querySelector(".setup-navigation"),
  setupProgress: document.querySelector("#setup-progress"),
  statusDot: document.querySelector("#status-dot"),
  title: document.querySelector("#title"),
  updateAction: document.querySelector("#update-action"),
  updateBanner: document.querySelector("#update-banner"),
  updateDismiss: document.querySelector("#update-dismiss"),
  updateMessage: document.querySelector("#update-message"),
  updateProgress: document.querySelector("#update-progress"),
  updateTitle: document.querySelector("#update-title"),
  welcomeContinue: document.querySelector("#welcome-continue"),
  welcomeScreen: document.querySelector("#welcome-screen"),
};

let primaryAction = null;
let updateAction = null;
let discoveryPending = false;
let discoverySignature = null;
let firstRunBuild = null;
let firstRunPhase = null;
let selectedConnection = "local";
let remoteTransport = "direct";
let remoteConnectionPending = false;
let editingConnection = false;
let activeRemoteRetry = null;

function show(element, visible) {
  element.classList.toggle("hidden", !visible);
}

function bundledRuntimeLabel() {
  return firstRunBuild?.runtimeFlavor === "jit" ? "JIT"
    : firstRunBuild?.runtimeFlavor === "aot" ? "AOT (experimental)" : null;
}

function render({
  activity = null,
  description,
  dot = "working",
  eyebrow = t("setup.desktopCompanion", "DESKTOP COMPANION"),
  showInstall = false,
  title,
}) {
  elements.eyebrow.textContent = eyebrow;
  elements.title.textContent = title;
  elements.description.textContent = description;
  elements.statusDot.className = `status-dot ${dot}`;
  show(elements.activity, Boolean(activity));
  if (activity) {
    elements.activityLabel.textContent = activity;
  }
  const bundled = bundledRuntimeLabel();
  elements.installButton.textContent = bundled
    ? t("setup.installBundled", "Install bundled OpenClaw")
    : t("setup.installOpenClaw", "Install OpenClaw");
  elements.bundledInstall.textContent = bundled
    ? t("setup.bundledRuntimeLabel", "Bundled with app v{version} · {flavor}", {
        version: firstRunBuild.version,
        flavor: bundled,
      })
    : "";
  show(elements.bundledInstall, Boolean(bundled));
  show(elements.channelLabel, !bundled);
  show(elements.channelField, !bundled);
  elements.installHint.textContent = bundled
    ? t(
        "setup.installBundledHint",
        "Installs this app's bundled OpenClaw runtime in ~/.openclaw. Update the desktop app to change versions.",
      )
    : firstRunBuild?.platform === "freebsd"
      ? t("setup.installFreeBsdHint", "Installs the CLI in ~/.openclaw using your system Node.js and npm.")
      : t("setup.installHint", "Installs OpenClaw and its managed runtime in ~/.openclaw.");
  show(elements.installControls, showInstall);
  show(elements.actionControls, false);
  show(elements.editConnection, false);
  show(elements.welcomeScreen, false);
  show(elements.connectionChoices, false);
  show(elements.discovery, true);
}

function renderAction(options, action) {
  render(options);
  primaryAction = action;
  elements.primaryAction.textContent = options.actionLabel;
  show(elements.actionControls, true);
}

function formatInstallLine(line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return line;
  }
  if (!event || typeof event !== "object" || !event.event) {
    return line;
  }
  if (event.event === "done" && event.ok === true) {
    return t("install.done", "✓ Installed{version}", {
      version: event.version ? ` ${event.version}` : "",
    });
  }
  if (event.event !== "step" || !event.name) {
    return line;
  }

  const name =
    {
      node: t("install.nodeRuntime", "Node runtime"),
      git: t("install.gitCheckout", "Git checkout"),
      openclaw: t("install.openClawCli", "OpenClaw CLI"),
      "gateway-service": t("install.gatewayService", "Gateway service"),
      "control-ui": t("install.controlUiBuild", "Control UI build"),
      "cli-build": t("install.cliBuild", "CLI build"),
    }[event.name] || event.name;
  switch (event.status) {
    case "start":
      return t("install.stepStart", "→ {name}{version}…", {
        name,
        version: event.version ? ` ${event.version}` : "",
      });
    case "ok":
      return t("install.stepDone", "✓ {name}", { name });
    case "skip":
      return t("install.stepSkipped", "– {name} skipped{reason}", {
        name,
        reason: event.reason ? ` (${event.reason})` : "",
      });
    case "warn":
      return t("install.stepWarning", "! {name}{reason}", {
        name,
        reason: event.reason ? `: ${event.reason}` : "",
      });
    default:
      return line;
  }
}

function appendLog(line) {
  elements.installLog.textContent += `${formatInstallLine(line)}\n`;
  elements.installLog.scrollTop = elements.installLog.scrollHeight;
}

function renderUpdate({ action = null, actionLabel = "", message, progress = false, title }) {
  elements.updateTitle.textContent = title;
  elements.updateMessage.textContent = message;
  updateAction = action;
  elements.updateAction.textContent = actionLabel;
  show(elements.updateAction, Boolean(action));
  show(elements.updateProgress, progress);
  show(elements.updateBanner, true);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) {
    return "";
  }
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function friendlyError(error) {
  if (typeof error === "string") {
    return error;
  }
  return error?.message || t("setup.operationFailed", "OpenClaw could not complete the operation.");
}

function gatewayHost(gateway) {
  return (gateway.host || "").trim().replace(/\.$/, "");
}

function renderGateways(gateways) {
  elements.gatewayList.replaceChildren();
  elements.discoveryStatus.textContent = gateways.length
    ? t("setup.gatewaysFound", "{count} FOUND", { count: gateways.length })
    : t("setup.searching", "SEARCHING");
  elements.remoteSubtitle.textContent = gateways.length
    ? t("setup.nearbyGatewaysFound", "Nearby Gateways found: {count}", { count: gateways.length })
    : t("setup.remoteSubtitle", "Connect to a Gateway running elsewhere.");
  if (!gateways.length) {
    const empty = document.createElement("p");
    empty.className = "discovery-empty";
    empty.textContent = t("setup.lookingNearby", "Looking for nearby OpenClaw gateways…");
    elements.gatewayList.append(empty);
    return;
  }

  for (const gateway of gateways) {
    const button = document.createElement("button");
    button.className = "gateway-card";
    button.type = "button";
    button.disabled = !(
      gateway.tls || gateway.directReachable || gatewayHost(gateway).toLowerCase().endsWith(".ts.net")
    );
    if (button.disabled) {
      button.title = t(
        "setup.gatewayNoDirectConnection",
        "This gateway does not advertise a direct connection.",
      );
    }

    const copy = document.createElement("span");
    copy.className = "gateway-copy";
    const name = document.createElement("span");
    name.className = "gateway-name";
    name.textContent = gateway.name;
    const endpoint = document.createElement("span");
    endpoint.className = "gateway-endpoint";
    endpoint.textContent = `${gatewayHost(gateway)}:${gateway.port}`;
    copy.append(name, endpoint);

    const badge = document.createElement("span");
    badge.className = `gateway-badge${gateway.tls ? " secure" : ""}`;
    badge.textContent = gateway.tls ? "TLS" : "HTTP";
    button.append(copy, badge);
    button.addEventListener("click", () => {
      if (
        selectedConnection === "remote" &&
        !elements.connectionChoices.classList.contains("hidden")
      ) {
        const host = gatewayHost(gateway);
        const urlHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
        selectRemoteTransport("direct");
        elements.remoteUrl.value = `${gateway.tls ? "https" : "http"}://${urlHost}:${gateway.port}`;
        void connectRemoteGateway();
        return;
      }
      button.disabled = true;
      void invoke("connect_discovered_gateway", {
        host: gateway.host,
        port: gateway.port,
        tls: gateway.tls,
      })
        .then(() => {
          button.disabled = false;
          elements.discoveryStatus.textContent = t("setup.windowOpened", "WINDOW OPENED");
        })
        .catch(() => {
          button.disabled = false;
          elements.discoveryStatus.textContent = t("setup.connectFailed", "CONNECT FAILED");
        });
    });
    elements.gatewayList.append(button);
  }
}

async function refreshGateways() {
  if (discoveryPending) {
    return;
  }
  discoveryPending = true;
  try {
    const gateways = await invoke("discover_gateways");
    const signature = JSON.stringify(gateways);
    if (signature !== discoverySignature) {
      discoverySignature = signature;
      renderGateways(gateways);
    }
  } catch {
    discoverySignature = null;
    elements.discoveryStatus.textContent = t("setup.unavailable", "UNAVAILABLE");
  } finally {
    discoveryPending = false;
  }
}

async function connect(action) {
  render(action ? {
    activity: action === "restart"
      ? t("setup.restartingGateway", "Restarting Gateway…")
      : t("setup.startingGateway", "Starting Gateway…"),
    description: t("setup.waitingForGateway", "OpenClaw is waiting for the local Gateway to become healthy."),
    eyebrow: t("setup.gatewayEyebrow", "GATEWAY"),
    title: t("setup.oneMoment", "One moment"),
  } : {
    activity: t("setup.checkingLocalServices", "Checking local services…"),
    description: t("setup.preparingControlUi", "Finding your gateway and preparing the Control UI."),
    title: t("setup.connecting", "Connecting to OpenClaw"),
  });
  try {
    if (action) {
      await invoke("gateway_action", { action });
      return;
    }
    const snapshot = await invoke("bootstrap");
    if (snapshot.phase === "missingCli" || snapshot.phase === "unconfigured") {
      firstRunPhase = snapshot.phase;
      if (firstRunBuild?.releaseBuild === false && !bundledRuntimeLabel()) {
        elements.channel.value = "dev";
      }
      if (snapshot.setupError) {
        renderConnectionChoices(snapshot.setupError);
      } else {
        renderWelcome();
      }
    } else if (snapshot.phase === "remoteError") {
      renderRemoteRetry(snapshot.detail);
    }
  } catch (error) {
    renderRetry(friendlyError(error));
  }
}

function renderWelcome() {
  render({
    description:
      t("setup.welcomeDescription", "Your personal AI assistant, living wherever you choose. It answers questions, works with your files and apps, and can chat with you wherever you are."),
    dot: "idle",
    eyebrow: t("setup.welcomeEyebrow", "WELCOME"),
    title: t("setup.welcomeTitle", "Welcome to OpenClaw"),
  });
  show(elements.discovery, false);
  show(elements.welcomeScreen, true);
}

function renderConnectionChoices(error = null) {
  const freebsd = firstRunBuild?.platform === "freebsd";
  const bundled = bundledRuntimeLabel();
  elements.localSubtitle.textContent = freebsd
    ? t("setup.freeBsdLocalSubtitle", "Connect to a Gateway you start with the FreeBSD service or in a terminal.")
    : bundled
      ? t("setup.bundledLocalSubtitle", "Bundled with app v{version} · {flavor}. Installs and starts automatically.", {
          version: firstRunBuild.version,
          flavor: bundled,
        })
      : t("setup.localSubtitle", "Private to this computer. Installs and starts automatically.");
  render({
    description: error || (freebsd
      ? t("setup.freeBsdChoiceHelp", "On FreeBSD, install the CLI if needed, then start your Gateway with the openclaw package service or run openclaw gateway run in a terminal. Connect here using the same account you used for onboarding.")
      : t("setup.localChoiceHelp", "Most people choose this computer. OpenClaw installs everything and keeps your assistant running in the background.")),
    dot: error ? "error" : "idle",
    eyebrow: t("setup.chooseGatewayEyebrow", "CHOOSE YOUR GATEWAY"),
    title: t("setup.chooseGatewayTitle", "Where should your assistant live?"),
  });
  show(elements.connectionChoices, true);
  show(elements.setupProgress, true);
  selectConnection(selectedConnection);
}

function selectConnection(connection) {
  if (editingConnection && connection !== "remote") {
    return;
  }
  selectedConnection = connection;
  const isRemote = connection === "remote";
  elements.connectionLocal.classList.toggle("selected", !isRemote);
  elements.connectionRemote.classList.toggle("selected", isRemote);
  elements.connectionLocal.setAttribute("aria-pressed", String(!isRemote));
  elements.connectionRemote.setAttribute("aria-pressed", String(isRemote));
  elements.footerMode.textContent = isRemote
    ? t("setup.remoteGateway", "REMOTE GATEWAY")
    : t("setup.localGateway", "LOCAL GATEWAY");
  show(elements.remoteDetails, isRemote);
  show(elements.setupContinue, !isRemote && !editingConnection);
  elements.setupContinue.textContent = bundledRuntimeLabel() && firstRunPhase === "missingCli"
    ? t("setup.installBundled", "Install bundled OpenClaw")
    : t("common.continue", "Continue");
  show(elements.discovery, isRemote);
  if (isRemote) {
    void refreshGateways();
  }
}

function selectRemoteTransport(transport) {
  remoteTransport = transport;
  const direct = transport === "direct";
  elements.remoteTransportDirect.classList.toggle("selected", direct);
  elements.remoteTransportSsh.classList.toggle("selected", !direct);
  elements.remoteTransportDirect.setAttribute("aria-pressed", String(direct));
  elements.remoteTransportSsh.setAttribute("aria-pressed", String(!direct));
  show(elements.remoteUrlField, direct);
  show(elements.remoteSshField, !direct);
  show(elements.remoteFeedback, false);
}

function revealRemoteCredential(revealed) {
  for (const input of [elements.remoteToken, elements.remotePassword]) {
    input.type = revealed ? "text" : "password";
  }
  elements.remoteCredentialToggle.setAttribute("aria-pressed", String(revealed));
  elements.remoteCredentialToggle.setAttribute(
    "aria-label",
    revealed
      ? t("setup.hideCredential", "Hide credential")
      : t("setup.showCredential", "Show credential"),
  );
}

function syncRemoteAuthentication() {
  const password = elements.remoteAuthMethod.value === "password";
  elements.remoteTokenField.hidden = password;
  elements.remotePasswordField.hidden = !password;
  elements.remoteToken.disabled = password;
  elements.remotePassword.disabled = !password;
}

async function continueLocalSetup() {
  if (firstRunPhase === "unconfigured") {
    render({
      activity:
        firstRunBuild?.platform === "freebsd"
          ? "Connecting to your local Gateway…"
          : "Starting your local Gateway…",
      description: "OpenClaw is preparing your assistant on this computer.",
      eyebrow: "FIRST-RUN SETUP",
      title: "Preparing your companion",
    });
    try {
      await invoke("bootstrap", { explicitLocal: true });
    } catch (error) {
      renderRetry(friendlyError(error));
    }
    return;
  }
  if (firstRunBuild?.releaseBuild === false && !bundledRuntimeLabel()) {
    render({
      description:
        firstRunBuild?.platform === "freebsd"
          ? "Install a compatible system Node.js and npm before installing the CLI. Then start your Gateway with the package service or openclaw gateway run."
          : "This development build works best with a matching OpenClaw release channel.",
      eyebrow: "FIRST-RUN SETUP",
      showInstall: true,
      title: "Choose a release channel",
    });
    return;
  }
  await install();
}

async function connectRemoteGateway() {
  if (remoteConnectionPending) {
    return;
  }

  const isDirect = remoteTransport === "direct";
  const endpoint = isDirect ? elements.remoteUrl : elements.remoteSshTarget;
  const endpointValue = endpoint.value.trim();
  if (!endpointValue) {
    endpoint.setAttribute("aria-invalid", "true");
    endpoint.focus();
    showRemoteFeedback(
      isDirect
        ? t("setup.enterGatewayUrl", "Enter a Gateway URL to continue.")
        : t("setup.enterSshTarget", "Enter an SSH target to continue."),
      true,
    );
    return;
  }

  const portValue = elements.remotePort.value.trim();
  const remotePort = portValue ? Number(portValue) : null;
  if (!isDirect && (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535)) {
    elements.remotePort.setAttribute("aria-invalid", "true");
    elements.remotePort.focus();
    showRemoteFeedback(t("setup.enterGatewayPortRange", "Enter a Gateway port between 1 and 65535."), true);
    return;
  }

  endpoint.removeAttribute("aria-invalid");
  elements.remotePort.removeAttribute("aria-invalid");
  remoteConnectionPending = true;
  elements.remoteConnect.disabled = true;
  elements.setupContinue.disabled = true;
  showRemoteFeedback(t("setup.preparingRemoteDashboard", "Preparing the remote dashboard…"), false);

  try {
    await invoke("connect_remote_gateway", {
      transport: remoteTransport,
      url: isDirect ? endpointValue : null,
      sshTarget: isDirect ? null : endpointValue,
      token:
        elements.remoteAuthMethod.value === "token" ? elements.remoteToken.value || null : null,
      password:
        elements.remoteAuthMethod.value === "password"
          ? elements.remotePassword.value || null
          : null,
      remotePort: isDirect ? null : remotePort,
    });
    showRemoteFeedback(t("setup.openingRemoteDashboard", "Opening the remote dashboard…"), false);
  } catch (error) {
    showRemoteFeedback(friendlyError(error), true);
  } finally {
    remoteConnectionPending = false;
    elements.remoteConnect.disabled = false;
    elements.setupContinue.disabled = false;
  }
}

function showRemoteFeedback(message, isError) {
  elements.remoteFeedback.textContent = message;
  elements.remoteFeedback.classList.toggle("error", isError);
  show(elements.remoteFeedback, true);
}

function renderRemoteRetry(message) {
  editingConnection = true;
  renderAction(
    {
      actionLabel: t("common.retry", "Retry"),
      description: message || t("setup.remoteRetryHelp", "Open Connection Settings to check the remote Gateway."),
      dot: "error",
      eyebrow: t("setup.remoteGateway", "REMOTE GATEWAY"),
      title: t("setup.connectionNeedsAttention", "Connection needs attention"),
    },
    retryRemote,
  );
  show(elements.discovery, false);
  show(elements.editConnection, true);
}

async function retryRemote() {
  const attempt = {};
  activeRemoteRetry = attempt;
  elements.primaryAction.disabled = true;
  try {
    // Retry the saved route, resolving credentials afresh without saving the
    // editor's empty secret fields or selecting a local service.
    const snapshot = await invoke("bootstrap", { remoteRetry: true });
    if (activeRemoteRetry === attempt && snapshot.phase === "remoteError") {
      renderRemoteRetry(snapshot.detail);
    }
  } catch (error) {
    if (activeRemoteRetry === attempt) {
      renderRemoteRetry(friendlyError(error));
    }
  } finally {
    elements.primaryAction.disabled = false;
  }
}

async function editConnection() {
  // Native Settings entry retires preparation; its late IPC reply must not
  // replace the editor in a still-live recovery document either.
  activeRemoteRetry = null;
  editingConnection = true;
  render({
    description: t("setup.updateRemoteConnection", "Update the remote Gateway address or authentication."),
    dot: "idle",
    eyebrow: t("setup.remoteGateway", "REMOTE GATEWAY"),
    title: t("setup.connectionSettings", "Connection Settings"),
  });
  show(elements.connectionChoices, true);
  show(elements.connectionLocal, false);
  elements.connectionLocal.disabled = true;
  show(elements.connectionRemote, false);
  show(elements.setupNavigation, true);
  show(elements.setupProgress, false);
  show(elements.setupContinue, false);
  selectConnection("remote");
  elements.remoteToken.value = "";
  elements.remotePassword.value = "";
  elements.remoteAuthMethod.value = "token";
  syncRemoteAuthentication();
  revealRemoteCredential(false);
  elements.remoteCredentialHint.textContent =
    t("setup.savedCredentialsHint", "Saved credentials stay hidden. Leave blank to keep them for the same connection.");
  try {
    const settings = await invoke("bootstrap", { connectionSettings: true });
    const remote = settings.remote;
    selectRemoteTransport(remote?.transport === "ssh" ? "ssh" : "direct");
    elements.remoteUrl.value = remote?.url || "";
    elements.remoteSshTarget.value = remote?.sshTarget || "";
    elements.remotePort.value = remote?.remotePort || 18789;
    if (settings.detail) {
      showRemoteFeedback(settings.detail, true);
    }
    if (remote) {
      primaryAction = retryRemote;
      elements.primaryAction.textContent = t("common.retry", "Retry");
      show(elements.actionControls, true);
    }
  } catch (error) {
    showRemoteFeedback(friendlyError(error), true);
  }
}

async function closeConnectionSettings() {
  elements.setupBack.disabled = true;
  try {
    await invoke("close_connection_settings");
  } catch (error) {
    showRemoteFeedback(friendlyError(error), true);
  } finally {
    elements.setupBack.disabled = false;
  }
}

async function install() {
  elements.installButton.disabled = true;
  elements.channel.disabled = true;
  elements.installLog.textContent = "";
  elements.logStatus.textContent = t("setup.running", "RUNNING");
  show(elements.logWrap, true);
  render({
    activity: t("setup.installingOpenClaw", "Installing OpenClaw…"),
    description:
      bundledRuntimeLabel()
        ? t("setup.installingBundledRuntime", "This app's bundled OpenClaw runtime is being installed in your home directory.")
        : firstRunBuild?.platform === "freebsd"
        ? t("setup.installingFreeBsdCli", "Installing the CLI requires a compatible system Node.js and npm. Start the Gateway with the package service or in a terminal after installation.")
        : t("setup.installingRuntime", "OpenClaw and its managed runtime are being installed in your home directory."),
    eyebrow: t("setup.installingEyebrow", "INSTALLING"),
    title: t("setup.preparingCompanion", "Preparing your companion"),
  });
  try {
    await invoke("install_cli", { channel: bundledRuntimeLabel() ? "stable" : elements.channel.value });
    elements.logStatus.textContent = t("setup.complete", "COMPLETE");
  } catch (error) {
    const message = friendlyError(error);
    elements.logStatus.textContent = t("setup.failed", "FAILED");
    appendLog(message);
    render({
      description: message,
      dot: "error",
      eyebrow: t("setup.issueEyebrow", "SETUP ISSUE"),
      showInstall: true,
      title: t("setup.needsAttention", "OpenClaw needs attention"),
    });
  } finally {
    elements.installButton.disabled = false;
    elements.channel.disabled = false;
  }
}

function renderRetry(message) {
  show(elements.logWrap, false);
  renderAction(
    {
      actionLabel: t("common.tryAgain", "Try again"),
      description: message,
      dot: "error",
      eyebrow: t("setup.connectionIssue", "CONNECTION ISSUE"),
      // A broken managed CLI can only be replaced by reinstalling; retry alone
      // must never be the sole exit from a connection failure.
      showInstall: true,
      title: t("setup.needsAttention", "OpenClaw needs attention"),
    },
    connect,
  );
}

elements.installButton.addEventListener("click", () => {
  void install();
});
elements.welcomeContinue.addEventListener("click", () => renderConnectionChoices());
elements.connectionLocal.addEventListener("click", () => selectConnection("local"));
elements.connectionRemote.addEventListener("click", () => selectConnection("remote"));
elements.setupBack.addEventListener("click", () =>
  editingConnection ? closeConnectionSettings() : renderWelcome(),
);
elements.setupContinue.addEventListener("click", () => {
  void continueLocalSetup();
});
elements.remoteDetails.addEventListener("submit", (event) => {
  event.preventDefault();
  void connectRemoteGateway();
});
elements.remoteAuthMethod.addEventListener("change", () => {
  elements.remoteToken.value = "";
  elements.remotePassword.value = "";
  revealRemoteCredential(false);
  syncRemoteAuthentication();
  show(elements.remoteFeedback, false);
});
elements.remoteCredentialToggle.addEventListener("click", () => {
  revealRemoteCredential(elements.remoteCredentialToggle.getAttribute("aria-pressed") !== "true");
});
elements.remoteTransportDirect.addEventListener("click", () => selectRemoteTransport("direct"));
elements.remoteTransportSsh.addEventListener("click", () => selectRemoteTransport("ssh"));
for (const input of [
  elements.remoteUrl,
  elements.remoteSshTarget,
  elements.remotePort,
  elements.remoteToken,
  elements.remotePassword,
]) {
  input.addEventListener("input", () => {
    input.removeAttribute("aria-invalid");
    show(elements.remoteFeedback, false);
  });
}
elements.primaryAction.addEventListener("click", () => {
  void primaryAction?.();
});
elements.editConnection.addEventListener("click", () => {
  void editConnection();
});
elements.updateAction.addEventListener("click", () => {
  void updateAction?.();
});
elements.updateDismiss.addEventListener("click", () => {
  show(elements.updateBanner, false);
});

await listen("install-progress", ({ payload }) => appendLog(payload.line));
await listen("updater://not-available", () => {
  renderUpdate({
    message: t("update.noneAvailable", "No update is available."),
    title: t("update.upToDate", "OpenClaw is up to date"),
  });
});
await listen("updater://available", ({ payload }) => {
  elements.updateProgress.removeAttribute("value");
  renderUpdate({
    message: t("update.downloading", "Downloading in the background…"),
    progress: true,
    title: t("update.downloadingVersion", "Update available v{version} — downloading…", { version: payload.version }),
  });
});
await listen("updater://progress", ({ payload }) => {
  if (payload.total) {
    elements.updateProgress.max = payload.total;
    elements.updateProgress.value = payload.downloaded;
    elements.updateMessage.textContent = t("update.downloadProgress", "{downloaded} of {total}", {
      downloaded: formatBytes(payload.downloaded),
      total: formatBytes(payload.total),
    });
  } else {
    elements.updateProgress.removeAttribute("value");
    elements.updateMessage.textContent = t("update.downloaded", "{size} downloaded", {
      size: formatBytes(payload.downloaded),
    });
  }
});
await listen("updater://ready", ({ payload }) => {
  renderUpdate({
    action: () => invoke("relaunch"),
    actionLabel: t("update.restartToUpdate", "Restart to update"),
    message: t("update.readyMessage", "Version v{version} is installed and ready.", { version: payload.version }),
    title: t("update.ready", "Update ready"),
  });
});
await listen("updater://available-manual", ({ payload }) => {
  const availableUpdate = {
    message: t("update.manualMessage", "Install the latest system package from the release page."),
    title: t("update.available", "Update available v{version}", { version: payload.version }),
  };
  const openDownloadPage = async () => {
    let result = availableUpdate;
    try {
      await invoke("open_release_page");
    } catch (error) {
      result = {
        message: friendlyError(error),
        title: t("update.openPageFailed", "Could not open release page"),
      };
    }
    if (updateAction !== openDownloadPage || elements.updateBanner.classList.contains("hidden")) {
      return;
    }
    renderUpdate({
      ...result,
      action: openDownloadPage,
      actionLabel: t("update.openDownloadPage", "Open download page"),
    });
  };
  renderUpdate({
    ...availableUpdate,
    action: openDownloadPage,
    actionLabel: t("update.openDownloadPage", "Open download page"),
  });
});
await listen("updater://error", ({ payload }) => {
  renderUpdate({
    message: payload.message,
    title: t("update.checkFailed", "Update check failed"),
  });
});
void invoke("updater_ready");
void refreshGateways();
window.setInterval(() => void refreshGateways(), 2000);

const mode = new URLSearchParams(window.location.search).get("mode");
firstRunBuild = await invoke("build_info").catch(() => null);
if (firstRunBuild?.runtimeFlavor === "jit" || firstRunBuild?.runtimeFlavor === "aot") {
  elements.runtimeFlavor.textContent = firstRunBuild.runtimeFlavor === "aot"
    ? t("setup.bundledAot", "BUNDLED AOT · EXPERIMENTAL")
    : t("setup.bundledJit", "BUNDLED JIT");
  if (firstRunBuild.testProfile) {
    elements.runtimeFlavor.textContent += t("setup.profileLabel", " · PROFILE {profile}", {
      profile: firstRunBuild.testProfile.toUpperCase(),
    });
  }
  elements.runtimeFlavor.title = t("setup.runtimeVersion", "OpenClaw {version}", { version: firstRunBuild.version });
  show(elements.runtimeFlavor, true);
  show(elements.runtimeSeparator, true);
}
if (mode === "connectionSettings") {
  await editConnection();
} else if (mode === "remoteError") {
  renderRemoteRetry();
} else if (mode === "missingCli") {
  render({
    description: t("setup.installCliDescription", "Install the OpenClaw CLI to connect to a local Gateway."),
    dot: "idle",
    eyebrow: t("setup.cliRequired", "CLI REQUIRED"),
    showInstall: true,
    title: t("setup.needsCli", "OpenClaw needs the CLI"),
  });
} else if (mode === "reconnecting") {
  render({
    activity: t("setup.retryingEveryFewSeconds", "Retrying every few seconds…"),
    description:
      t("setup.gatewayConnectionDropped", "The Gateway connection dropped. OpenClaw will restore the dashboard automatically."),
    eyebrow: t("setup.gatewayOffline", "GATEWAY OFFLINE"),
    title: t("setup.reconnecting", "Reconnecting"),
  });
} else if (mode === "stopped") {
  renderAction(
    {
      actionLabel: t("setup.startGateway", "Start Gateway"),
      description:
        t("setup.gatewayStoppedDescription", "The Gateway is stopped. The desktop companion will remain available in the tray."),
      dot: "idle",
      eyebrow: t("setup.gatewayStopped", "GATEWAY STOPPED"),
      title: t("setup.standingBy", "OpenClaw is standing by"),
    },
    () => connect("start"),
  );
} else if (mode === "error") {
  renderRetry(t("setup.lastGatewayActionFailed", "The last Gateway action failed. Check the service, then retry."));
} else {
  await connect();
}
