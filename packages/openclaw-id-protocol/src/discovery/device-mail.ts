import { isClawId } from "../keys.js";
// Browser-D mailbox relay wire contract; the caller signs these exact paths and body bytes.
import type { SignedStatement } from "../statements/types.js";

/** Operations the local owner browser may relay; paths never come from the caller. */
export type DeviceMailOperation = "bind" | "receive" | "send" | "ack";

/** Exact bytes and credentials supplied by the browser, never retained by the Gateway. */
export type DeviceMailRequest = {
  operation: DeviceMailOperation;
  body: string;
  after: string;
  signature: string;
  idToken: string;
  certificate: SignedStatement<"OwnerDeviceCert">;
};

/** Resolves the one permitted path/method for this claw and a canonical cursor. */
export function deviceMailRoute(operation: DeviceMailOperation, clawId: string, after: string) {
  if (!isClawId(clawId)) {
    throw new Error("invalid claw id");
  }
  if (!/^(0|[1-9][0-9]{0,14})$/.test(after)) {
    throw new Error("invalid mailbox cursor");
  }
  const mail = `/v1/claws/${clawId}/mailbox`;
  switch (operation) {
    case "bind":
      return { method: "POST", path: "/v1/devices" };
    case "receive":
      return { method: "GET", path: `${mail}/device?after=${after}&wait=20` };
    case "send":
      return { method: "POST", path: mail };
    case "ack":
      return { method: "POST", path: `${mail}/device/ack` };
    default:
      throw new Error("invalid mailbox operation");
  }
}
