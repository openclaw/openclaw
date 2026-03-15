//#region node_modules/.pnpm/music-metadata@11.12.3/node_modules/music-metadata/lib/matroska/types.js
const TargetType = {
	10: "shot",
	20: "scene",
	30: "track",
	40: "part",
	50: "album",
	60: "edition",
	70: "collection"
};
const TrackType = {
	video: 1,
	audio: 2,
	complex: 3,
	logo: 4,
	subtitle: 17,
	button: 18,
	control: 32
};
const TrackTypeValueToKeyMap = {
	[TrackType.video]: "video",
	[TrackType.audio]: "audio",
	[TrackType.complex]: "complex",
	[TrackType.logo]: "logo",
	[TrackType.subtitle]: "subtitle",
	[TrackType.button]: "button",
	[TrackType.control]: "control"
};
//#endregion
export { TrackType as n, TrackTypeValueToKeyMap as r, TargetType as t };
