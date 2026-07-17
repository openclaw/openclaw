const tauri = window["__TAURI__"];
const { invoke } = tauri.core;
const { listen } = tauri.event;

const elements = {
  chip: document.querySelector("#agent-chip"),
  composer: document.querySelector("#composer"),
  input: document.querySelector("#message"),
  send: document.querySelector("#send"),
  sendIcon: document.querySelector("#send-icon"),
  status: document.querySelector("#status"),
};

let sending = false;
let accepted = false;
let hiding = false;
let hideTimer = null;
let acceptedTimer = null;
let visibilitySequence = 0;
let sendError = "";

function friendlyError(error) {
  if (typeof error === "string") {
    return error;
  }
  return error?.message || "Could not send the message.";
}

function setError(message = "") {
  elements.status.textContent = message;
  elements.composer.classList.toggle("has-error", Boolean(message));
}

function updateSendButton() {
  const empty = !elements.input.value.trim();
  elements.send.disabled = empty || sending || accepted;
  elements.send.classList.toggle("sending", sending);
  elements.send.classList.toggle("accepted", accepted);
  elements.sendIcon.textContent = sending ? "" : accepted ? "✓" : "↑";
  elements.input.readOnly = sending || accepted;
}

function nameHue(name) {
  let hash = 0;
  for (const character of name) {
    hash = (hash * 31 + character.codePointAt(0)) >>> 0;
  }
  return hash % 360;
}

function renderIdentity(identity) {
  const name = identity?.name?.trim() || "Agent";
  const initial = [...name][0]?.toUpperCase() || "A";
  elements.chip.textContent = identity?.emoji?.trim() || initial;
  elements.chip.style.setProperty("--agent-hue", nameHue(name));
  elements.input.placeholder = `Message ${name}`;
}

async function refreshIdentity() {
  try {
    renderIdentity(await invoke("quickchat_identity"));
  } catch {
    renderIdentity({ name: "Agent" });
  }
}

async function requestHide(force = false) {
  if ((accepted && !force) || hiding) {
    return;
  }
  visibilitySequence += 1;
  const hideSequence = visibilitySequence;
  hiding = true;
  document.body.classList.remove("shown");
  window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(async () => {
    try {
      await invoke("quickchat_hide");
    } catch (error) {
      if (visibilitySequence === hideSequence) {
        sendError = friendlyError(error);
        setError(sendError);
        document.body.classList.add("shown");
        elements.input.focus();
      }
    } finally {
      if (visibilitySequence === hideSequence) {
        hiding = false;
      }
    }
  }, 100);
}

function reveal() {
  window.clearTimeout(hideTimer);
  if (accepted) {
    window.clearTimeout(acceptedTimer);
    acceptedTimer = null;
    accepted = false;
  }
  hiding = false;
  setError(sendError);
  updateSendButton();
  document.body.classList.remove("shown");
  window.requestAnimationFrame(() => {
    document.body.classList.add("shown");
    elements.input.focus();
  });
  void refreshIdentity();
}

async function send(openDashboard) {
  const message = elements.input.value.trim();
  if (!message || sending || accepted) {
    return;
  }
  sending = true;
  sendError = "";
  setError();
  updateSendButton();
  try {
    await invoke("quickchat_send", { message });
    sending = false;
    accepted = true;
    sendError = "";
    elements.input.value = "";
    updateSendButton();
    if (openDashboard) {
      void invoke("quickchat_show_dashboard");
    }
    acceptedTimer = window.setTimeout(() => {
      accepted = false;
      updateSendButton();
      void requestHide(true);
    }, 450);
  } catch (error) {
    sending = false;
    sendError = friendlyError(error);
    setError(sendError);
    updateSendButton();
    elements.input.focus();
  }
}

elements.input.addEventListener("input", () => {
  sendError = "";
  setError();
  updateSendButton();
});
elements.input.addEventListener("keydown", (event) => {
  if (event.isComposing || event.keyCode === 229) {
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    void requestHide();
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    void send(event.ctrlKey);
  }
});
elements.send.addEventListener("click", () => {
  void send(false);
});

await listen("quickchat:shown", () => {
  visibilitySequence += 1;
  reveal();
});
await listen("quickchat:hide-requested", () => {
  void requestHide();
});

const readySequence = visibilitySequence;
try {
  const shouldShow = await invoke("quickchat_ready");
  if (visibilitySequence === readySequence) {
    if (shouldShow) {
      reveal();
    } else {
      void requestHide(true);
    }
  }
} catch {
  void requestHide(true);
}
