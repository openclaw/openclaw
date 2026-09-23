const tauri = window["__TAURI__"];
const { invoke } = tauri.core;
const { listen } = tauri.event;

const elements = {
  activity: document.querySelector("#activity"),
  activityLabel: document.querySelector("#activity-label"),
  actionControls: document.querySelector("#action-controls"),
  channel: document.querySelector("#channel"),
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

function render({
  activity = null,
  description,
  dot = "working",
  eyebrow = "DESKTOP COMPANION",
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
  elements.installHint.textContent =
    firstRunBuild?.platform === "freebsd"
      ? "Installs the CLI in ~/.openclaw using your system Node.js and npm."
      : "Installs the CLI and managed Node runtime in ~/.openclaw.";
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
    return `✓ Installed${event.version ? ` ${event.version}` : ""}`;
  }
  if (event.event !== "step" || !event.name) {
    return line;
  }

  const name =
    {
      node: "Node runtime",
      git: "Git checkout",
      openclaw: "OpenClaw CLI",
      "gateway-service": "Gateway service",
      "control-ui": "Control UI build",
      "cli-build": "CLI build",
    }[event.name] || event.name;
  switch (event.status) {
    case "start":
      return `→ ${name}${event.version ? ` ${event.version}` : ""}…`;
    case "ok":
      return `✓ ${name}`;
    case "skip":
      return `– ${name} skipped${event.reason ? ` (${event.reason})` : ""}`;
    case "warn":
      return `! ${name}${event.reason ? `: ${event.reason}` : ""}`;
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
  return error?.message || "OpenClaw could not complete the operation.";
}

function gatewayHost(gateway) {
  return (gateway.host || "").trim().replace(/\.$/, "");
}

function canConnectDirect(gateway) {
  return (
    gateway.tls || gateway.directReachable || gatewayHost(gateway).toLowerCase().endsWith(".ts.net")
  );
}

function renderGateways(gateways) {
  elements.gatewayList.replaceChildren();
  elements.discoveryStatus.textContent = gateways.length ? `${gateways.length} FOUND` : "SEARCHING";
  elements.remoteSubtitle.textContent = gateways.length
    ? `${gateways.length} nearby Gateway${gateways.length === 1 ? "" : "s"} found on your network.`
    : "Connect to a Gateway running elsewhere.";
  if (!gateways.length) {
    const empty = document.createElement("p");
    empty.className = "discovery-empty";
    empty.textContent = "Looking for nearby OpenClaw gateways…";
    elements.gatewayList.append(empty);
    return;
  }

  for (const gateway of gateways) {
    const button = document.createElement("button");
    button.className = "gateway-card";
    button.type = "button";
    button.disabled = !canConnectDirect(gateway);
    if (button.disabled) {
      button.title = "This gateway does not advertise a direct connection.";
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
          elements.discoveryStatus.textContent = "WINDOW OPENED";
        })
        .catch(() => {
          button.disabled = false;
          elements.discoveryStatus.textContent = "CONNECT FAILED";
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
    elements.discoveryStatus.textContent = "UNAVAILABLE";
  } finally {
    discoveryPending = false;
  }
}

async function connect() {
  render({
    activity: "Checking local services…",
    description: "Finding your gateway and preparing the Control UI.",
    title: "Connecting to OpenClaw",
  });
  try {
    const snapshot = await invoke("bootstrap");
    if (snapshot.phase === "missingCli" || snapshot.phase === "unconfigured") {
      firstRunPhase = snapshot.phase;
      firstRunBuild = await invoke("build_info").catch(() => null);
      if (firstRunBuild?.releaseBuild === false) {
        elements.channel.value = "dev";
      }
      renderWelcome();
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
      "Your personal AI assistant, living wherever you choose. It answers questions, works with your files and apps, and can chat with you wherever you are.",
    dot: "idle",
    eyebrow: "WELCOME",
    title: "Welcome to OpenClaw",
  });
  show(elements.discovery, false);
  show(elements.welcomeScreen, true);
}

function renderConnectionChoices() {
  const freebsd = firstRunBuild?.platform === "freebsd";
  elements.localSubtitle.textContent = freebsd
    ? "Connect to a Gateway you start with the FreeBSD service or in a terminal."
    : "Private to this computer. Installs and starts automatically.";
  render({
    description: freebsd
      ? "On FreeBSD, install the CLI if needed, then start your Gateway with the openclaw package service or run openclaw gateway run in a terminal. Connect here using the same account you used for onboarding."
      : "Most people choose this computer. OpenClaw installs everything and keeps your assistant running in the background.",
    dot: "idle",
    eyebrow: "CHOOSE YOUR GATEWAY",
    title: "Where should your assistant live?",
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
  elements.footerMode.textContent = isRemote ? "REMOTE GATEWAY" : "LOCAL GATEWAY";
  show(elements.remoteDetails, isRemote);
  show(elements.setupContinue, !isRemote && !editingConnection);
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
    revealed ? "Hide credential" : "Show credential",
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
  if (firstRunBuild?.releaseBuild === false) {
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
      isDirect ? "Enter a Gateway URL to continue." : "Enter an SSH target to continue.",
      true,
    );
    return;
  }

  const portValue = elements.remotePort.value.trim();
  const remotePort = portValue ? Number(portValue) : null;
  if (!isDirect && (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535)) {
    elements.remotePort.setAttribute("aria-invalid", "true");
    elements.remotePort.focus();
    showRemoteFeedback("Enter a Gateway port between 1 and 65535.", true);
    return;
  }

  endpoint.removeAttribute("aria-invalid");
  elements.remotePort.removeAttribute("aria-invalid");
  remoteConnectionPending = true;
  elements.remoteConnect.disabled = true;
  elements.setupContinue.disabled = true;
  showRemoteFeedback("Preparing the remote dashboard…", false);

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
    showRemoteFeedback("Opening the remote dashboard…", false);
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
      actionLabel: "Retry",
      description: message || "Open Connection Settings to check the remote Gateway.",
      dot: "error",
      eyebrow: "REMOTE GATEWAY",
      title: "Connection needs attention",
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
    description: "Update the remote Gateway address or authentication.",
    dot: "idle",
    eyebrow: "REMOTE GATEWAY",
    title: "Connection Settings",
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
    "Saved credentials stay hidden. Leave blank to keep them for the same connection.";
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
      elements.primaryAction.textContent = "Retry";
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
  elements.logStatus.textContent = "RUNNING";
  show(elements.logWrap, true);
  render({
    activity: "Installing OpenClaw…",
    description:
      firstRunBuild?.platform === "freebsd"
        ? "Installing the CLI requires a compatible system Node.js and npm. Start the Gateway with the package service or in a terminal after installation."
        : "A managed CLI and Node runtime are being installed in your home directory.",
    eyebrow: "INSTALLING",
    title: "Preparing your companion",
  });
  try {
    await invoke("install_cli", { channel: elements.channel.value });
    elements.logStatus.textContent = "COMPLETE";
  } catch (error) {
    const message = friendlyError(error);
    elements.logStatus.textContent = "FAILED";
    appendLog(message);
    render({
      description: message,
      dot: "error",
      eyebrow: "SETUP ISSUE",
      showInstall: true,
      title: "OpenClaw needs attention",
    });
  } finally {
    elements.installButton.disabled = false;
    elements.channel.disabled = false;
  }
}

async function runGatewayAction(action) {
  render({
    activity: `${action === "restart" ? "Restarting" : "Starting"} gateway…`,
    description: "OpenClaw is waiting for the local gateway to become healthy.",
    eyebrow: "GATEWAY",
    title: "One moment",
  });
  try {
    await invoke("gateway_action", { action });
  } catch (error) {
    renderRetry(friendlyError(error));
  }
}

function renderRetry(message) {
  show(elements.logWrap, false);
  renderAction(
    {
      actionLabel: "Try again",
      description: message,
      dot: "error",
      eyebrow: "CONNECTION ISSUE",
      // A broken managed CLI can only be replaced by reinstalling; retry alone
      // must never be the sole exit from a connection failure.
      showInstall: true,
      title: "OpenClaw needs attention",
    },
    connect,
  );
}

elements.installButton.addEventListener("click", () => {
  void install();
});
elements.welcomeContinue.addEventListener("click", renderConnectionChoices);
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
    message: "No update is available.",
    title: "OpenClaw is up to date",
  });
});
await listen("updater://available", ({ payload }) => {
  elements.updateProgress.removeAttribute("value");
  renderUpdate({
    message: payload.notes || "Downloading in the background…",
    progress: true,
    title: `Update available v${payload.version} — downloading…`,
  });
});
await listen("updater://progress", ({ payload }) => {
  if (payload.total) {
    elements.updateProgress.max = payload.total;
    elements.updateProgress.value = payload.downloaded;
    elements.updateMessage.textContent = `${formatBytes(payload.downloaded)} of ${formatBytes(payload.total)}`;
  } else {
    elements.updateProgress.removeAttribute("value");
    elements.updateMessage.textContent = `${formatBytes(payload.downloaded)} downloaded`;
  }
});
await listen("updater://ready", ({ payload }) => {
  renderUpdate({
    action: () => invoke("relaunch"),
    actionLabel: "Restart to update",
    message: `Version v${payload.version} is installed and ready.`,
    title: "Update ready",
  });
});
await listen("updater://available-manual", ({ payload }) => {
  const openDownloadPage = () =>
    invoke("open_release_page").catch((error) => {
      if (updateAction !== openDownloadPage || elements.updateBanner.classList.contains("hidden")) {
        return;
      }
      renderUpdate({
        action: openDownloadPage,
        actionLabel: "Open download page",
        message: friendlyError(error),
        title: "Could not open release page",
      });
    });
  renderUpdate({
    action: openDownloadPage,
    actionLabel: "Open download page",
    message: payload.notes || "Install the latest system package from the release page.",
    title: `Update available v${payload.version}`,
  });
});
await listen("updater://error", ({ payload }) => {
  renderUpdate({
    message: payload.message,
    title: "Update check failed",
  });
});
void invoke("updater_ready");
void refreshGateways();
window.setInterval(() => void refreshGateways(), 2000);

const mode = new URLSearchParams(window.location.search).get("mode");
if (mode === "connectionSettings") {
  await editConnection();
} else if (mode === "remoteError") {
  renderRemoteRetry();
} else if (mode === "missingCli") {
  firstRunBuild = await invoke("build_info").catch(() => null);
  render({
    description: "Install the OpenClaw CLI to connect to a local Gateway.",
    dot: "idle",
    eyebrow: "CLI REQUIRED",
    showInstall: true,
    title: "OpenClaw needs the CLI",
  });
} else if (mode === "reconnecting") {
  render({
    activity: "Retrying every few seconds…",
    description:
      "The gateway connection dropped. OpenClaw will restore the dashboard automatically.",
    eyebrow: "GATEWAY OFFLINE",
    title: "Reconnecting",
  });
} else if (mode === "stopped") {
  renderAction(
    {
      actionLabel: "Start Gateway",
      description:
        "The gateway is stopped. The desktop companion will remain available in the tray.",
      dot: "idle",
      eyebrow: "GATEWAY STOPPED",
      title: "OpenClaw is standing by",
    },
    () => runGatewayAction("start"),
  );
} else if (mode === "error") {
  renderRetry("The last gateway action failed. Check the service, then retry.");
} else {
  await connect();
}
