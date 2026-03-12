import { o as isIpInCidr } from "./ip-DK-vcRii.js";
import os from "node:os";

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
	const ifaces = os.networkInterfaces();
	for (const entries of Object.values(ifaces)) {
		if (!entries) continue;
		for (const e of entries) {
			if (!e || e.internal) continue;
			const address = e.address?.trim();
			if (!address) continue;
			if (isTailnetIPv4(address)) ipv4.push(address);
			if (isTailnetIPv6(address)) ipv6.push(address);
		}
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
export { pickPrimaryTailnetIPv4 as n, pickPrimaryTailnetIPv6 as r, isTailnetIPv4 as t };