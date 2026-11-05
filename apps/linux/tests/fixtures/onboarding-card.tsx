import { render } from "@solidjs/web";
import type { GatewayBrowserClient } from "../../../../ui/src/api/gateway.ts";
import type { ApplicationContext } from "../../../../ui/src/app/context.ts";
import { ApplicationProvider } from "../../../../ui/src/lib/reactive/context.ts";
import { createCustodianActions } from "../../../../ui/src/pages/custodian/custodian-actions.ts";
import { CustodianSessionStore } from "../../../../ui/src/pages/custodian/custodian-session-store.ts";
import { CustodianSetupCard } from "../../../../ui/src/pages/custodian/custodian-setup-card.tsx";
import "../../../../ui/src/styles/base.css";
import "../../../../ui/src/styles/components.css";
import "../../../../ui/src/styles/custodian.css";
import "./onboarding-card.css";

// Only setup results and surrounding navigation are synthetic. The card and
// native capabilities are the production owners running in Tauri's WebKit.
const capabilityAtBoot = document.documentElement.dataset.nativeSetupAtBoot === "true";
window.dispatchEvent(new Event("openclaw:native-window-chrome-available"));
const instance = crypto.randomUUID();
const store = new CustodianSessionStore();
const client = {
  async request<T>(method: string): Promise<T> {
    if (method !== "openclaw.setup.auto") {
      throw new Error(`Unexpected fixture method: ${method}`);
    }
    const response = await fetch(`/fixture/setup${location.search}`);
    if (!response.ok) {
      throw new Error(`Fixture setup failed: ${response.status}`);
    }
    return response.json();
  },
} as GatewayBrowserClient;
const context = {
  gateway: {
    connection: { gatewayUrl: location.origin + "/fixture/" },
    snapshot: {
      client,
      phase: "connected",
      hello: { features: { methods: ["openclaw.setup.auto"] } },
    },
  },
  agents: { refreshList: async () => undefined },
} as unknown as ApplicationContext;

function report() {
  void fetch("/fixture/report", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      page: "primary",
      instance,
      path: location.pathname,
      capabilityAtBoot,
      currentGateway: window["__OPENCLAW_NATIVE_SETUP__"]?.currentGateway,
      setupStatus: store.autoSetup.result?.status,
    }),
  });
}

function title() {
  return location.pathname.includes("model-setup")
    ? "Local model setup"
    : location.pathname.includes("device/permissions")
      ? "Native permissions"
      : location.pathname.startsWith("/fixture/")
        ? "Custodian chat"
        : "Sibling path";
}

function leaveGatewayBase() {
  history.pushState({}, "", "/fixture-sibling/chat");
  document.querySelector("h1")!.textContent = title();
  report();
}

window.addEventListener("openclaw:gateway-notice", (event) => {
  const notice = event as CustomEvent<{ message: string }>;
  document.getElementById("action-error")!.textContent = notice.detail.message;
});
window.addEventListener("openclaw:native-gateways-changed", report);

render(
  () => {
    const { actions } = createCustodianActions(() => store);
    return (
      <ApplicationProvider value={context}>
        <header>OPENCLAW · SYNTHETIC GATEWAY DATA</header>
        <main>
          <h1>{title()}</h1>
          <p>Production setup card in the native desktop app. Provider results are synthetic.</p>
          <CustodianSetupCard store={store} actions={actions.setup} />
          <p id="action-error" role="alert" />
          <nav aria-label="Proof navigation">
            <a href="/fixture/chat/custodian">Open chat</a>
            <a href="/fixture/custodian?unavailable=1">Show unavailable provider</a>
            <button type="button" onClick={() => location.reload()}>
              Reload chat
            </button>
            <button type="button" onClick={leaveGatewayBase}>
              Open sibling path
            </button>
          </nav>
        </main>
      </ApplicationProvider>
    );
  },
  document.getElementById("app")!,
);
store.subscribe(report);
store.autoSetup.synchronize(context, true, location.origin);
report();
