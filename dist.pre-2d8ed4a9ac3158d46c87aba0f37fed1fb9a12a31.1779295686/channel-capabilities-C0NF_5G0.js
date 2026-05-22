import { a as normalizeAnyChannelId } from "./registry-CqoTFbCs.js";
import { n as getBundledChannelPlugin } from "./bundled-DQmG4e6_.js";
import { t as getChannelPlugin } from "./registry-no9ipK4H.js";
import "./plugins--jPjX2J7.js";
import { t as findBundledPackageChannelMetadata } from "./bundled-package-channel-metadata-CDbytHsY.js";
//#region src/commands/doctor/channel-capabilities.ts
const DEFAULT_DOCTOR_CHANNEL_CAPABILITIES = {
	dmAllowFromMode: "topOnly",
	groupModel: "sender",
	groupAllowFromFallbackToAllowFrom: true,
	warnOnEmptyGroupSenderAllowlist: true
};
function mergeDoctorChannelCapabilities(capabilities) {
	return {
		dmAllowFromMode: capabilities?.dmAllowFromMode ?? DEFAULT_DOCTOR_CHANNEL_CAPABILITIES.dmAllowFromMode,
		groupModel: capabilities?.groupModel ?? DEFAULT_DOCTOR_CHANNEL_CAPABILITIES.groupModel,
		groupAllowFromFallbackToAllowFrom: capabilities?.groupAllowFromFallbackToAllowFrom ?? DEFAULT_DOCTOR_CHANNEL_CAPABILITIES.groupAllowFromFallbackToAllowFrom,
		warnOnEmptyGroupSenderAllowlist: capabilities?.warnOnEmptyGroupSenderAllowlist ?? DEFAULT_DOCTOR_CHANNEL_CAPABILITIES.warnOnEmptyGroupSenderAllowlist
	};
}
function getManifestDoctorCapabilities(channelId) {
	return findBundledPackageChannelMetadata(channelId)?.doctorCapabilities;
}
function getDoctorChannelCapabilities(channelName) {
	if (!channelName) return DEFAULT_DOCTOR_CHANNEL_CAPABILITIES;
	const manifestCapabilities = getManifestDoctorCapabilities(channelName);
	if (manifestCapabilities) return mergeDoctorChannelCapabilities(manifestCapabilities);
	const channelId = normalizeAnyChannelId(channelName);
	if (!channelId) return DEFAULT_DOCTOR_CHANNEL_CAPABILITIES;
	const pluginDoctor = getChannelPlugin(channelId)?.doctor ?? getBundledChannelPlugin(channelId)?.doctor;
	if (pluginDoctor) return mergeDoctorChannelCapabilities(pluginDoctor);
	return mergeDoctorChannelCapabilities(getManifestDoctorCapabilities(channelId));
}
//#endregion
export { getDoctorChannelCapabilities as t };
