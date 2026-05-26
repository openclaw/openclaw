import { drainPendingDeliveries as coreDrainPendingDeliveries, type DeliverFn } from "../infra/outbound/delivery-queue.js";
type DrainPendingDeliveriesOptions = Omit<Parameters<typeof coreDrainPendingDeliveries>[0], "deliver"> & {
    deliver?: DeliverFn;
};
export declare function drainPendingDeliveries(opts: DrainPendingDeliveriesOptions): Promise<void>;
export {};
