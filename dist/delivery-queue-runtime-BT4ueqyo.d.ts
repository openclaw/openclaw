import { n as drainPendingDeliveries$1, t as DeliverFn } from "./delivery-queue-CL2xe51Q.js";

//#region src/plugin-sdk/delivery-queue-runtime.d.ts
type DrainPendingDeliveriesOptions = Omit<Parameters<typeof drainPendingDeliveries$1>[0], "deliver"> & {
  deliver?: DeliverFn;
};
declare function drainPendingDeliveries(opts: DrainPendingDeliveriesOptions): Promise<void>;
//#endregion
export { drainPendingDeliveries as t };