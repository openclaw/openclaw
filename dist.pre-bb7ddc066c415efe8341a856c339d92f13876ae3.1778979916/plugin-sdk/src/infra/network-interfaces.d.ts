import os from "node:os";
export type NetworkInterfacesSnapshot = ReturnType<typeof os.networkInterfaces>;
type NetworkInterfaceFamily = "IPv4" | "IPv6";
type ExternalNetworkInterfaceAddress = {
    name: string;
    address: string;
    family: NetworkInterfaceFamily;
};
export declare function readNetworkInterfaces(networkInterfaces?: () => NetworkInterfacesSnapshot): NetworkInterfacesSnapshot;
export declare function safeNetworkInterfaces(networkInterfaces?: () => NetworkInterfacesSnapshot): NetworkInterfacesSnapshot | undefined;
export declare function listExternalInterfaceAddresses(snapshot: NetworkInterfacesSnapshot | undefined, family?: NetworkInterfaceFamily): ExternalNetworkInterfaceAddress[];
export declare function pickMatchingExternalInterfaceAddress(snapshot: NetworkInterfacesSnapshot | undefined, params: {
    family: NetworkInterfaceFamily;
    preferredNames?: string[];
    matches?: (address: string) => boolean;
}): string | undefined;
export {};
