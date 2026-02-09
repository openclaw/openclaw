import { Urbit } from "@urbit/http-api";

let patched = false;

export function ensureUrbitConnectPatched() {
  if (patched) {
    return;
  }
  patched = true;
  Urbit.prototype.connect = async function patchedConnect() {
    const resp = await fetch(`${this.url}/~/login`, {
      method: "POST",
      body: `password=${this.code}`,
      credentials: "include",
    });

    if (resp.status >= 400) {
      throw new Error(`Login failed with status ${resp.status}`);
    }

    const cookie = resp.headers.get("set-cookie");
    if (cookie) {
      const match = /urbauth-~([\w-]+)/.exec(cookie);
      if (match) {
        if (!(this as unknown as { ship?: string | null }).ship) {
          (this as unknown as { ship?: string | null }).ship = match[1];
        }
        (this as unknown as { nodeId?: string }).nodeId = match[1];
      }
      (this as unknown as { cookie?: string }).cookie = cookie;
    }

    await (this as typeof Urbit.prototype).getShipName();
    await (this as typeof Urbit.prototype).getOurName();
  };
}

export { Urbit };
