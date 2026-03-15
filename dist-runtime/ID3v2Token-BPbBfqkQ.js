import { E as UINT8, S as UINT32_BE, _ as StringType, g as INT8, v as UINT16_BE } from "./BasicParser-CJDqseT1.js";
import { a as getBit } from "./Util-C3ovgFZT.js";
//#region node_modules/.pnpm/music-metadata@11.12.3/node_modules/music-metadata/lib/id3v2/ID3v2Token.js
/**
* The picture type according to the ID3v2 APIC frame
* Ref: http://id3.org/id3v2.3.0#Attached_picture
*/
const AttachedPictureType = {
	0: "Other",
	1: "32x32 pixels 'file icon' (PNG only)",
	2: "Other file icon",
	3: "Cover (front)",
	4: "Cover (back)",
	5: "Leaflet page",
	6: "Media (e.g. label side of CD)",
	7: "Lead artist/lead performer/soloist",
	8: "Artist/performer",
	9: "Conductor",
	10: "Band/Orchestra",
	11: "Composer",
	12: "Lyricist/text writer",
	13: "Recording Location",
	14: "During recording",
	15: "During performance",
	16: "Movie/video screen capture",
	17: "A bright coloured fish",
	18: "Illustration",
	19: "Band/artist logotype",
	20: "Publisher/Studio logotype"
};
/**
* https://id3.org/id3v2.3.0#Synchronised_lyrics.2Ftext
*/
const LyricsContentType = {
	other: 0,
	lyrics: 1,
	text: 2,
	movement_part: 3,
	events: 4,
	chord: 5,
	trivia_pop: 6
};
const TimestampFormat = {
	notSynchronized: 0,
	mpegFrameNumber: 1,
	milliseconds: 2
};
/**
* 28 bits (representing up to 256MB) integer, the msb is 0 to avoid 'false syncsignals'.
* 4 * %0xxxxxxx
*/
const UINT32SYNCSAFE = {
	get: (buf, off) => {
		return buf[off + 3] & 127 | buf[off + 2] << 7 | buf[off + 1] << 14 | buf[off] << 21;
	},
	len: 4
};
/**
* ID3v2 header
* Ref: http://id3.org/id3v2.3.0#ID3v2_header
* ToDo
*/
const ID3v2Header = {
	len: 10,
	get: (buf, off) => {
		return {
			fileIdentifier: new StringType(3, "ascii").get(buf, off),
			version: {
				major: INT8.get(buf, off + 3),
				revision: INT8.get(buf, off + 4)
			},
			flags: {
				unsynchronisation: getBit(buf, off + 5, 7),
				isExtendedHeader: getBit(buf, off + 5, 6),
				expIndicator: getBit(buf, off + 5, 5),
				footer: getBit(buf, off + 5, 4)
			},
			size: UINT32SYNCSAFE.get(buf, off + 6)
		};
	}
};
const ExtendedHeader = {
	len: 10,
	get: (buf, off) => {
		return {
			size: UINT32_BE.get(buf, off),
			extendedFlags: UINT16_BE.get(buf, off + 4),
			sizeOfPadding: UINT32_BE.get(buf, off + 6),
			crcDataPresent: getBit(buf, off + 4, 31)
		};
	}
};
const TextEncodingToken = {
	len: 1,
	get: (uint8Array, off) => {
		switch (uint8Array[off]) {
			case 0: return { encoding: "latin1" };
			case 1: return {
				encoding: "utf-16le",
				bom: true
			};
			case 2: return {
				encoding: "utf-16le",
				bom: false
			};
			case 3: return {
				encoding: "utf8",
				bom: false
			};
			default: return {
				encoding: "utf8",
				bom: false
			};
		}
	}
};
/**
* Used to read first portion of `SYLT` frame
*/
const TextHeader = {
	len: 4,
	get: (uint8Array, off) => {
		return {
			encoding: TextEncodingToken.get(uint8Array, off),
			language: new StringType(3, "latin1").get(uint8Array, off + 1)
		};
	}
};
/**
* Used to read first portion of `SYLT` frame
*/
const SyncTextHeader = {
	len: 6,
	get: (uint8Array, off) => {
		const text = TextHeader.get(uint8Array, off);
		return {
			encoding: text.encoding,
			language: text.language,
			timeStampFormat: UINT8.get(uint8Array, off + 4),
			contentType: UINT8.get(uint8Array, off + 5)
		};
	}
};
//#endregion
export { SyncTextHeader as a, TimestampFormat as c, LyricsContentType as i, UINT32SYNCSAFE as l, ExtendedHeader as n, TextEncodingToken as o, ID3v2Header as r, TextHeader as s, AttachedPictureType as t };
