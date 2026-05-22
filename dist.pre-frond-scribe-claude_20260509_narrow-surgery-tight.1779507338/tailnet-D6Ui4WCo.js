import { s as isIpInCidr } from "./ip-WAe3-2zT.js";
import os from "node:os";
//#region src/infra/network-interfaces.ts
function normalizeNetworkInterfaceFamily(family) {
	if (family === "IPv4" || family === 4) return "IPv4";
	if (family === "IPv6" || family === 6) return "IPv6";
}
function readNetworkInterfaces(networkInterfaces = os.networkInterfaces) {
	return networkInterfaces();
}
function safeNetworkInterfaces(networkInterfaces = os.networkInterfaces) {
	try {
		return readNetworkInterfaces(networkInterfaces);
	} catch {
		return;
	}
}
function listExternalInterfaceAddresses(snapshot, family) {
	const addresses = [];
	if (!snapshot) return addresses;
	for (const [name, entries] of Object.entries(snapshot)) {
		if (!entries) continue;
		for (const entry of entries) {
			if (!entry || entry.internal) continue;
			const address = entry.address?.trim();
			if (!address) continue;
			const entryFamily = normalizeNetworkInterfaceFamily(entry.family);
			if (!entryFamily || family && entryFamily !== family) continue;
			addresses.push({
				name,
				address,
				family: entryFamily
			});
		}
	}
	return addresses;
}
function pickMatchingExternalInterfaceAddress(snapshot, params) {
	const { family, preferredNames = [], matches = () => true } = params;
	const addresses = listExternalInterfaceAddresses(snapshot, family);
	for (const name of preferredNames) {
		const preferred = addresses.find((entry) => entry.name === name && matches(entry.address));
		if (preferred) return preferred.address;
	}
	return addresses.find((entry) => matches(entry.address))?.address;
}
//#endregion
//#region src/infra/tailnet.ts
const TAILNET_IPV4_CIDR = "100.64.0.0/10";
const TAILNET_IPV6_CIDR = "fd7a:115c:a1e0::/48";
function isTailnetIPv4(address) {
	return isIpInCidr(address, TAILNET_IPV4_CIDR);
}
function isTailnetIPv6(address) {
	return isIpInCidr(address, TAILNET_IPV6_CIDR);
}
function listTailnetAddresses() {
	const ipv4 = [];
	const ipv6 = [];
	for (const { address, family } of listExternalInterfaceAddresses(readNetworkInterfaces())) {
		if (family === "IPv4" && isTailnetIPv4(address)) ipv4.push(address);
		if (family === "IPv6" && isTailnetIPv6(address)) ipv6.push(address);
	}
	return {
		ipv4: [...new Set(ipv4)],
		ipv6: [...new Set(ipv6)]
	};
}
function pickPrimaryTailnetIPv4() {
	return listTailnetAddresses().ipv4[0];
}
function pickPrimaryTailnetIPv6() {
	return listTailnetAddresses().ipv6[0];
}
//#endregion
export { readNetworkInterfaces as a, pickMatchingExternalInterfaceAddress as i, pickPrimaryTailnetIPv4 as n, safeNetworkInterfaces as o, pickPrimaryTailnetIPv6 as r, isTailnetIPv4 as t };
