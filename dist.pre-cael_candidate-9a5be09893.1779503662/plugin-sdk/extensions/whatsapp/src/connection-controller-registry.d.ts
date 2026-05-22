import type { ActiveWebListener } from "./inbound/types.js";
type WhatsAppConnectionControllerHandle = {
    getActiveListener(): ActiveWebListener | null;
};
export declare function getRegisteredWhatsAppConnectionController(accountId: string): WhatsAppConnectionControllerHandle | null;
export declare function registerWhatsAppConnectionController(accountId: string, controller: WhatsAppConnectionControllerHandle): void;
export declare function unregisterWhatsAppConnectionController(accountId: string, controller: WhatsAppConnectionControllerHandle): void;
export {};
