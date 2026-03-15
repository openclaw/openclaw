import { o as __toESM } from "./chunk-DORXReHP.js";
import { t as require_src } from "./src-BaZokO46.js";
import { C as UINT32_LE, T as UINT64_LE, _ as StringType, s as makeUnexpectedFileContentError, t as BasicParser, y as UINT16_LE } from "./BasicParser-CJDqseT1.js";
import { a as getBit, c as stripNulls, n as decodeString } from "./Util-C3ovgFZT.js";
import { t as AttachedPictureType } from "./ID3v2Token-BPbBfqkQ.js";
import { n as TrackType } from "./types-BYhULvsH.js";
//#region node_modules/.pnpm/win-guid@0.2.1/node_modules/win-guid/lib/guid.js
var import_src = /* @__PURE__ */ __toESM(require_src(), 1);
/**
* Parse canonical GUID string (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)
* into Windows / CFBF byte order.
*/
function parseWindowsGuid(guid) {
	let s = guid.trim();
	if (s.length !== 36 || s[8] !== "-" || s[13] !== "-" || s[18] !== "-" || s[23] !== "-") {throw new Error(`Invalid GUID format: ${guid}`);}
	let v;
	const out = new Uint8Array(16);
	v = parseInt(s.slice(0, 8), 16);
	out[0] = v & 255;
	out[1] = v >>> 8 & 255;
	out[2] = v >>> 16 & 255;
	out[3] = v >>> 24 & 255;
	v = parseInt(s.slice(9, 13), 16);
	out[4] = v & 255;
	out[5] = v >>> 8 & 255;
	v = parseInt(s.slice(14, 18), 16);
	out[6] = v & 255;
	out[7] = v >>> 8 & 255;
	v = parseInt(s.slice(19, 23), 16);
	out[8] = v >>> 8 & 255;
	out[9] = v & 255;
	v = parseInt(s.slice(24, 32), 16);
	out[10] = v >>> 24 & 255;
	out[11] = v >>> 16 & 255;
	out[12] = v >>> 8 & 255;
	out[13] = v & 255;
	v = parseInt(s.slice(32, 36), 16);
	out[14] = v >>> 8 & 255;
	out[15] = v & 255;
	for (let i = 0; i < 16; i++) {if (!Number.isFinite(out[i])) throw new Error(`Invalid GUID format: ${guid}`);}
	if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(s)) {throw new Error(`Invalid GUID format: ${guid}`);}
	return out;
}
var Guid = class Guid {
	constructor(bytes) {
		if (bytes.length !== 16) {throw new Error("GUID must be exactly 16 bytes");}
		this.bytes = bytes;
	}
	static fromString(guid) {
		return new Guid(parseWindowsGuid(guid));
	}
	/**
	* Convert Windows / CFBF byte order into canonical GUID string:
	* xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
	*/
	toString() {
		const b = this.bytes;
		const hx = (n) => n.toString(16).padStart(2, "0");
		return `${hx(b[3]) + hx(b[2]) + hx(b[1]) + hx(b[0])}-${hx(b[5]) + hx(b[4])}-${hx(b[7]) + hx(b[6])}-${hx(b[8]) + hx(b[9])}-${hx(b[10]) + hx(b[11]) + hx(b[12]) + hx(b[13]) + hx(b[14]) + hx(b[15])}`.toUpperCase();
	}
	/**
	* Compare against a Uint8Array containing GUID bytes
	* in Windows / CFBF layout.
	*/
	equals(buf, offset = 0) {
		if (offset < 0 || buf.length - offset < 16) {return false;}
		const a = this.bytes;
		for (let i = 0; i < 16; i++) {if (buf[offset + i] !== a[i]) return false;}
		return true;
	}
};
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.3/node_modules/music-metadata/lib/asf/AsfGuid.js
/**
* Ref:
* - https://tools.ietf.org/html/draft-fleischman-asf-01, Appendix A: ASF GUIDs
* - http://drang.s4.xrea.com/program/tips/id3tag/wmp/10_asf_guids.html
* - http://drang.s4.xrea.com/program/tips/id3tag/wmp/index.html
* - http://drang.s4.xrea.com/program/tips/id3tag/wmp/10_asf_guids.html
*
* ASF File Structure:
* - https://msdn.microsoft.com/en-us/library/windows/desktop/ee663575(v=vs.85).aspx
*
* ASF GUIDs:
* - http://drang.s4.xrea.com/program/tips/id3tag/wmp/10_asf_guids.html
* - https://github.com/dji-sdk/FFmpeg/blob/master/libavformat/asf.c
*/
var AsfGuid = class AsfGuid {
	static fromBin(bin, offset = 0) {
		return new AsfGuid(AsfGuid.decode(bin, offset));
	}
	/**
	* Decode GUID in format like "B503BF5F-2EA9-CF11-8EE3-00C00C205365"
	* @param objectId Binary GUID
	* @param offset Read offset in bytes, default 0
	* @returns GUID as dashed hexadecimal representation
	*/
	static decode(objectId, offset = 0) {
		return new Guid(objectId.subarray(offset, offset + 16)).toString();
	}
	/**
	* Decode stream type
	* @param mediaType Media type GUID
	* @returns Media type
	*/
	static decodeMediaType(mediaType) {
		switch (mediaType.str) {
			case AsfGuid.AudioMedia.str: return "audio";
			case AsfGuid.VideoMedia.str: return "video";
			case AsfGuid.CommandMedia.str: return "command";
			case AsfGuid.Degradable_JPEG_Media.str: return "degradable-jpeg";
			case AsfGuid.FileTransferMedia.str: return "file-transfer";
			case AsfGuid.BinaryMedia.str: return "binary";
		}
	}
	/**
	* Encode GUID
	* @param guid GUID like: "B503BF5F-2EA9-CF11-8EE3-00C00C205365"
	* @returns Encoded Binary GUID
	*/
	static encode(guid) {
		return parseWindowsGuid(guid);
	}
	constructor(str) {
		this.str = str;
	}
	equals(guid) {
		return this.str === guid.str;
	}
	toBin() {
		return AsfGuid.encode(this.str);
	}
};
AsfGuid.HeaderObject = new AsfGuid("75B22630-668E-11CF-A6D9-00AA0062CE6C");
AsfGuid.DataObject = new AsfGuid("75B22636-668E-11CF-A6D9-00AA0062CE6C");
AsfGuid.SimpleIndexObject = new AsfGuid("33000890-E5B1-11CF-89F4-00A0C90349CB");
AsfGuid.IndexObject = new AsfGuid("D6E229D3-35DA-11D1-9034-00A0C90349BE");
AsfGuid.MediaObjectIndexObject = new AsfGuid("FEB103F8-12AD-4C64-840F-2A1D2F7AD48C");
AsfGuid.TimecodeIndexObject = new AsfGuid("3CB73FD0-0C4A-4803-953D-EDF7B6228F0C");
AsfGuid.FilePropertiesObject = new AsfGuid("8CABDCA1-A947-11CF-8EE4-00C00C205365");
AsfGuid.StreamPropertiesObject = new AsfGuid("B7DC0791-A9B7-11CF-8EE6-00C00C205365");
AsfGuid.HeaderExtensionObject = new AsfGuid("5FBF03B5-A92E-11CF-8EE3-00C00C205365");
AsfGuid.CodecListObject = new AsfGuid("86D15240-311D-11D0-A3A4-00A0C90348F6");
AsfGuid.ScriptCommandObject = new AsfGuid("1EFB1A30-0B62-11D0-A39B-00A0C90348F6");
AsfGuid.MarkerObject = new AsfGuid("F487CD01-A951-11CF-8EE6-00C00C205365");
AsfGuid.BitrateMutualExclusionObject = new AsfGuid("D6E229DC-35DA-11D1-9034-00A0C90349BE");
AsfGuid.ErrorCorrectionObject = new AsfGuid("75B22635-668E-11CF-A6D9-00AA0062CE6C");
AsfGuid.ContentDescriptionObject = new AsfGuid("75B22633-668E-11CF-A6D9-00AA0062CE6C");
AsfGuid.ExtendedContentDescriptionObject = new AsfGuid("D2D0A440-E307-11D2-97F0-00A0C95EA850");
AsfGuid.ContentBrandingObject = new AsfGuid("2211B3FA-BD23-11D2-B4B7-00A0C955FC6E");
AsfGuid.StreamBitratePropertiesObject = new AsfGuid("7BF875CE-468D-11D1-8D82-006097C9A2B2");
AsfGuid.ContentEncryptionObject = new AsfGuid("2211B3FB-BD23-11D2-B4B7-00A0C955FC6E");
AsfGuid.ExtendedContentEncryptionObject = new AsfGuid("298AE614-2622-4C17-B935-DAE07EE9289C");
AsfGuid.DigitalSignatureObject = new AsfGuid("2211B3FC-BD23-11D2-B4B7-00A0C955FC6E");
AsfGuid.PaddingObject = new AsfGuid("1806D474-CADF-4509-A4BA-9AABCB96AAE8");
AsfGuid.ExtendedStreamPropertiesObject = new AsfGuid("14E6A5CB-C672-4332-8399-A96952065B5A");
AsfGuid.AdvancedMutualExclusionObject = new AsfGuid("A08649CF-4775-4670-8A16-6E35357566CD");
AsfGuid.GroupMutualExclusionObject = new AsfGuid("D1465A40-5A79-4338-B71B-E36B8FD6C249");
AsfGuid.StreamPrioritizationObject = new AsfGuid("D4FED15B-88D3-454F-81F0-ED5C45999E24");
AsfGuid.BandwidthSharingObject = new AsfGuid("A69609E6-517B-11D2-B6AF-00C04FD908E9");
AsfGuid.LanguageListObject = new AsfGuid("7C4346A9-EFE0-4BFC-B229-393EDE415C85");
AsfGuid.MetadataObject = new AsfGuid("C5F8CBEA-5BAF-4877-8467-AA8C44FA4CCA");
AsfGuid.MetadataLibraryObject = new AsfGuid("44231C94-9498-49D1-A141-1D134E457054");
AsfGuid.IndexParametersObject = new AsfGuid("D6E229DF-35DA-11D1-9034-00A0C90349BE");
AsfGuid.MediaObjectIndexParametersObject = new AsfGuid("6B203BAD-3F11-48E4-ACA8-D7613DE2CFA7");
AsfGuid.TimecodeIndexParametersObject = new AsfGuid("F55E496D-9797-4B5D-8C8B-604DFE9BFB24");
AsfGuid.CompatibilityObject = new AsfGuid("26F18B5D-4584-47EC-9F5F-0E651F0452C9");
AsfGuid.AdvancedContentEncryptionObject = new AsfGuid("43058533-6981-49E6-9B74-AD12CB86D58C");
AsfGuid.AudioMedia = new AsfGuid("F8699E40-5B4D-11CF-A8FD-00805F5C442B");
AsfGuid.VideoMedia = new AsfGuid("BC19EFC0-5B4D-11CF-A8FD-00805F5C442B");
AsfGuid.CommandMedia = new AsfGuid("59DACFC0-59E6-11D0-A3AC-00A0C90348F6");
AsfGuid.JFIF_Media = new AsfGuid("B61BE100-5B4E-11CF-A8FD-00805F5C442B");
AsfGuid.Degradable_JPEG_Media = new AsfGuid("35907DE0-E415-11CF-A917-00805F5C442B");
AsfGuid.FileTransferMedia = new AsfGuid("91BD222C-F21C-497A-8B6D-5AA86BFC0185");
AsfGuid.BinaryMedia = new AsfGuid("3AFB65E2-47EF-40F2-AC2C-70A90D71D343");
AsfGuid.ASF_Index_Placeholder_Object = new AsfGuid("D9AADE20-7C17-4F9C-BC28-8555DD98E2A2");
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.3/node_modules/music-metadata/lib/asf/AsfUtil.js
function getParserForAttr(i) {
	return attributeParsers[i];
}
function parseUnicodeAttr(uint8Array) {
	return stripNulls(decodeString(uint8Array, "utf-16le"));
}
const attributeParsers = [
	parseUnicodeAttr,
	parseByteArrayAttr,
	parseBoolAttr,
	parseDWordAttr,
	parseQWordAttr,
	parseWordAttr,
	parseByteArrayAttr
];
function parseByteArrayAttr(buf) {
	return new Uint8Array(buf);
}
function parseBoolAttr(buf, offset = 0) {
	return parseWordAttr(buf, offset) === 1;
}
function parseDWordAttr(buf, offset = 0) {
	return UINT32_LE.get(buf, offset);
}
function parseQWordAttr(buf, offset = 0) {
	return UINT64_LE.get(buf, offset);
}
function parseWordAttr(buf, offset = 0) {
	return UINT16_LE.get(buf, offset);
}
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.3/node_modules/music-metadata/lib/asf/AsfObject.js
var AsfContentParseError = class extends makeUnexpectedFileContentError("ASF") {};
/**
* Token for: 3. ASF top-level Header Object
* Ref: http://drang.s4.xrea.com/program/tips/id3tag/wmp/03_asf_top_level_header_object.html#3
*/
const TopLevelHeaderObjectToken = {
	len: 30,
	get: (buf, off) => {
		return {
			objectId: AsfGuid.fromBin(buf, off),
			objectSize: Number(UINT64_LE.get(buf, off + 16)),
			numberOfHeaderObjects: UINT32_LE.get(buf, off + 24)
		};
	}
};
/**
* Token for: 3.1 Header Object (mandatory, one only)
* Ref: http://drang.s4.xrea.com/program/tips/id3tag/wmp/03_asf_top_level_header_object.html#3_1
*/
const HeaderObjectToken = {
	len: 24,
	get: (buf, off) => {
		return {
			objectId: AsfGuid.fromBin(buf, off),
			objectSize: Number(UINT64_LE.get(buf, off + 16))
		};
	}
};
var State = class {
	constructor(header) {
		this.len = Number(header.objectSize) - HeaderObjectToken.len;
	}
	postProcessTag(tags, name, valueType, data) {
		if (name === "WM/Picture") {tags.push({
			id: name,
			value: WmPictureToken.fromBuffer(data)
		});}
		else {
			const parseAttr = getParserForAttr(valueType);
			if (!parseAttr) {throw new AsfContentParseError(`unexpected value headerType: ${valueType}`);}
			tags.push({
				id: name,
				value: parseAttr(data)
			});
		}
	}
};
var IgnoreObjectState = class extends State {
	get(_buf, _off) {
		return null;
	}
};
/**
* Token for: 3.2: File Properties Object (mandatory, one only)
* Ref: http://drang.s4.xrea.com/program/tips/id3tag/wmp/03_asf_top_level_header_object.html#3_2
*/
var FilePropertiesObject = class extends State {
	get(buf, off) {
		return {
			fileId: AsfGuid.fromBin(buf, off),
			fileSize: UINT64_LE.get(buf, off + 16),
			creationDate: UINT64_LE.get(buf, off + 24),
			dataPacketsCount: UINT64_LE.get(buf, off + 32),
			playDuration: UINT64_LE.get(buf, off + 40),
			sendDuration: UINT64_LE.get(buf, off + 48),
			preroll: UINT64_LE.get(buf, off + 56),
			flags: {
				broadcast: getBit(buf, off + 64, 24),
				seekable: getBit(buf, off + 64, 25)
			},
			minimumDataPacketSize: UINT32_LE.get(buf, off + 68),
			maximumDataPacketSize: UINT32_LE.get(buf, off + 72),
			maximumBitrate: UINT32_LE.get(buf, off + 76)
		};
	}
};
FilePropertiesObject.guid = AsfGuid.FilePropertiesObject;
/**
* Token for: 3.3 Stream Properties Object (mandatory, one per stream)
* Ref: http://drang.s4.xrea.com/program/tips/id3tag/wmp/03_asf_top_level_header_object.html#3_3
*/
var StreamPropertiesObject = class extends State {
	get(buf, off) {
		return {
			streamType: AsfGuid.decodeMediaType(AsfGuid.fromBin(buf, off)),
			errorCorrectionType: AsfGuid.fromBin(buf, off + 8)
		};
	}
};
StreamPropertiesObject.guid = AsfGuid.StreamPropertiesObject;
/**
* 3.4: Header Extension Object (mandatory, one only)
* Ref: http://drang.s4.xrea.com/program/tips/id3tag/wmp/03_asf_top_level_header_object.html#3_4
*/
var HeaderExtensionObject = class {
	constructor() {
		this.len = 22;
	}
	get(buf, off) {
		const view = new DataView(buf.buffer, off);
		return {
			reserved1: AsfGuid.fromBin(buf, off),
			reserved2: view.getUint16(16, true),
			extensionDataSize: view.getUint16(18, true)
		};
	}
};
HeaderExtensionObject.guid = AsfGuid.HeaderExtensionObject;
/**
* 3.5: The Codec List Object provides user-friendly information about the codecs and formats used to encode the content found in the ASF file.
* Ref: http://drang.s4.xrea.com/program/tips/id3tag/wmp/03_asf_top_level_header_object.html#3_5
*/
const CodecListObjectHeader = {
	len: 20,
	get: (buf, off) => {
		return { entryCount: new DataView(buf.buffer, off).getUint16(16, true) };
	}
};
async function readString(tokenizer) {
	const length = await tokenizer.readNumber(UINT16_LE);
	return (await tokenizer.readToken(new StringType(length * 2, "utf-16le"))).replace("\0", "");
}
/**
* 3.5: Read the Codec-List-Object, which provides user-friendly information about the codecs and formats used to encode the content found in the ASF file.
* Ref: http://drang.s4.xrea.com/program/tips/id3tag/wmp/03_asf_top_level_header_object.html#3_5
*/
async function readCodecEntries(tokenizer) {
	const codecHeader = await tokenizer.readToken(CodecListObjectHeader);
	const entries = [];
	for (let i = 0; i < codecHeader.entryCount; ++i) {entries.push(await readCodecEntry(tokenizer));}
	return entries;
}
async function readInformation(tokenizer) {
	const length = await tokenizer.readNumber(UINT16_LE);
	const buf = new Uint8Array(length);
	await tokenizer.readBuffer(buf);
	return buf;
}
/**
* Read Codec-Entries
* @param tokenizer
*/
async function readCodecEntry(tokenizer) {
	const type = await tokenizer.readNumber(UINT16_LE);
	return {
		type: {
			videoCodec: (type & 1) === 1,
			audioCodec: (type & 2) === 2
		},
		codecName: await readString(tokenizer),
		description: await readString(tokenizer),
		information: await readInformation(tokenizer)
	};
}
/**
* 3.10 Content Description Object (optional, one only)
* Ref: http://drang.s4.xrea.com/program/tips/id3tag/wmp/03_asf_top_level_header_object.html#3_10
*/
var ContentDescriptionObjectState = class ContentDescriptionObjectState extends State {
	get(buf, off) {
		const tags = [];
		const view = new DataView(buf.buffer, off);
		let pos = 10;
		for (let i = 0; i < ContentDescriptionObjectState.contentDescTags.length; ++i) {
			const length = view.getUint16(i * 2, true);
			if (length > 0) {
				const tagName = ContentDescriptionObjectState.contentDescTags[i];
				const end = pos + length;
				tags.push({
					id: tagName,
					value: parseUnicodeAttr(buf.subarray(off + pos, off + end))
				});
				pos = end;
			}
		}
		return tags;
	}
};
ContentDescriptionObjectState.guid = AsfGuid.ContentDescriptionObject;
ContentDescriptionObjectState.contentDescTags = [
	"Title",
	"Author",
	"Copyright",
	"Description",
	"Rating"
];
/**
* 3.11 Extended Content Description Object (optional, one only)
* Ref: http://drang.s4.xrea.com/program/tips/id3tag/wmp/03_asf_top_level_header_object.html#3_11
*/
var ExtendedContentDescriptionObjectState = class extends State {
	get(buf, off) {
		const tags = [];
		const view = new DataView(buf.buffer, off);
		const attrCount = view.getUint16(0, true);
		let pos = 2;
		for (let i = 0; i < attrCount; i += 1) {
			const nameLen = view.getUint16(pos, true);
			pos += 2;
			const name = parseUnicodeAttr(buf.subarray(off + pos, off + pos + nameLen));
			pos += nameLen;
			const valueType = view.getUint16(pos, true);
			pos += 2;
			const valueLen = view.getUint16(pos, true);
			pos += 2;
			const value = buf.subarray(off + pos, off + pos + valueLen);
			pos += valueLen;
			this.postProcessTag(tags, name, valueType, value);
		}
		return tags;
	}
};
ExtendedContentDescriptionObjectState.guid = AsfGuid.ExtendedContentDescriptionObject;
/**
* 4.1 Extended Stream Properties Object (optional, 1 per media stream)
* Ref: http://drang.s4.xrea.com/program/tips/id3tag/wmp/04_objects_in_the_asf_header_extension_object.html#4_1
*/
var ExtendedStreamPropertiesObjectState = class extends State {
	get(buf, off) {
		const view = new DataView(buf.buffer, off);
		return {
			startTime: UINT64_LE.get(buf, off),
			endTime: UINT64_LE.get(buf, off + 8),
			dataBitrate: view.getInt32(12, true),
			bufferSize: view.getInt32(16, true),
			initialBufferFullness: view.getInt32(20, true),
			alternateDataBitrate: view.getInt32(24, true),
			alternateBufferSize: view.getInt32(28, true),
			alternateInitialBufferFullness: view.getInt32(32, true),
			maximumObjectSize: view.getInt32(36, true),
			flags: {
				reliableFlag: getBit(buf, off + 40, 0),
				seekableFlag: getBit(buf, off + 40, 1),
				resendLiveCleanpointsFlag: getBit(buf, off + 40, 2)
			},
			streamNumber: view.getInt16(42, true),
			streamLanguageId: view.getInt16(44, true),
			averageTimePerFrame: view.getInt32(52, true),
			streamNameCount: view.getInt32(54, true),
			payloadExtensionSystems: view.getInt32(56, true),
			streamNames: [],
			streamPropertiesObject: null
		};
	}
};
ExtendedStreamPropertiesObjectState.guid = AsfGuid.ExtendedStreamPropertiesObject;
/**
* 4.7  Metadata Object (optional, 0 or 1)
* Ref: http://drang.s4.xrea.com/program/tips/id3tag/wmp/04_objects_in_the_asf_header_extension_object.html#4_7
*/
var MetadataObjectState = class extends State {
	get(uint8Array, off) {
		const tags = [];
		const view = new DataView(uint8Array.buffer, off);
		const descriptionRecordsCount = view.getUint16(0, true);
		let pos = 2;
		for (let i = 0; i < descriptionRecordsCount; i += 1) {
			pos += 4;
			const nameLen = view.getUint16(pos, true);
			pos += 2;
			const dataType = view.getUint16(pos, true);
			pos += 2;
			const dataLen = view.getUint32(pos, true);
			pos += 4;
			const name = parseUnicodeAttr(uint8Array.subarray(off + pos, off + pos + nameLen));
			pos += nameLen;
			const data = uint8Array.subarray(off + pos, off + pos + dataLen);
			pos += dataLen;
			this.postProcessTag(tags, name, dataType, data);
		}
		return tags;
	}
};
MetadataObjectState.guid = AsfGuid.MetadataObject;
var MetadataLibraryObjectState = class extends MetadataObjectState {};
MetadataLibraryObjectState.guid = AsfGuid.MetadataLibraryObject;
/**
* Ref: https://msdn.microsoft.com/en-us/library/windows/desktop/dd757977(v=vs.85).aspx
*/
var WmPictureToken = class WmPictureToken {
	static fromBuffer(buffer) {
		return new WmPictureToken(buffer.length).get(buffer, 0);
	}
	constructor(len) {
		this.len = len;
	}
	get(buffer, offset) {
		const view = new DataView(buffer.buffer, offset);
		const typeId = view.getUint8(0);
		const size = view.getInt32(1, true);
		let index = 5;
		while (view.getUint16(index) !== 0) {index += 2;}
		const format = new StringType(index - 5, "utf-16le").get(buffer, 5);
		while (view.getUint16(index) !== 0) {index += 2;}
		const description = new StringType(index - 5, "utf-16le").get(buffer, 5);
		return {
			type: AttachedPictureType[typeId],
			format,
			description,
			size,
			data: buffer.slice(index + 4)
		};
	}
};
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.3/node_modules/music-metadata/lib/asf/AsfParser.js
const debug = (0, import_src.default)("music-metadata:parser:ASF");
const headerType = "asf";
/**
* Windows Media Metadata Usage Guidelines
* - Ref: https://msdn.microsoft.com/en-us/library/ms867702.aspx
*
* Ref:
* - https://tools.ietf.org/html/draft-fleischman-asf-01
* - https://hwiegman.home.xs4all.nl/fileformats/asf/ASF_Specification.pdf
* - http://drang.s4.xrea.com/program/tips/id3tag/wmp/index.html
* - https://msdn.microsoft.com/en-us/library/windows/desktop/ee663575(v=vs.85).aspx
*/
var AsfParser = class extends BasicParser {
	async parse() {
		const header = await this.tokenizer.readToken(TopLevelHeaderObjectToken);
		if (!header.objectId.equals(AsfGuid.HeaderObject)) {throw new AsfContentParseError(`expected asf header; but was not found; got: ${header.objectId.str}`);}
		await this.parseObjectHeader(header.numberOfHeaderObjects);
	}
	async parseObjectHeader(numberOfObjectHeaders) {
		let tags;
		do {
			const header = await this.tokenizer.readToken(HeaderObjectToken);
			debug("header GUID=%s", header.objectId.str);
			switch (header.objectId.str) {
				case FilePropertiesObject.guid.str: {
					const fpo = await this.tokenizer.readToken(new FilePropertiesObject(header));
					this.metadata.setFormat("duration", Number(fpo.playDuration / BigInt(1e3)) / 1e4 - Number(fpo.preroll) / 1e3);
					this.metadata.setFormat("bitrate", fpo.maximumBitrate);
					break;
				}
				case StreamPropertiesObject.guid.str: {
					const spo = await this.tokenizer.readToken(new StreamPropertiesObject(header));
					this.metadata.setFormat("container", `ASF/${spo.streamType}`);
					break;
				}
				case HeaderExtensionObject.guid.str: {
					const extHeader = await this.tokenizer.readToken(new HeaderExtensionObject());
					await this.parseExtensionObject(extHeader.extensionDataSize);
					break;
				}
				case ContentDescriptionObjectState.guid.str:
					tags = await this.tokenizer.readToken(new ContentDescriptionObjectState(header));
					await this.addTags(tags);
					break;
				case ExtendedContentDescriptionObjectState.guid.str:
					tags = await this.tokenizer.readToken(new ExtendedContentDescriptionObjectState(header));
					await this.addTags(tags);
					break;
				case AsfGuid.CodecListObject.str: {
					const codecs = await readCodecEntries(this.tokenizer);
					codecs.forEach((codec) => {
						this.metadata.addStreamInfo({
							type: codec.type.videoCodec ? TrackType.video : TrackType.audio,
							codecName: codec.codecName
						});
					});
					const audioCodecs = codecs.filter((codec) => codec.type.audioCodec).map((codec) => codec.codecName).join("/");
					this.metadata.setFormat("codec", audioCodecs);
					break;
				}
				case AsfGuid.StreamBitratePropertiesObject.str:
					await this.tokenizer.ignore(header.objectSize - HeaderObjectToken.len);
					break;
				case AsfGuid.PaddingObject.str:
					debug("Padding: %s bytes", header.objectSize - HeaderObjectToken.len);
					await this.tokenizer.ignore(header.objectSize - HeaderObjectToken.len);
					break;
				default:
					this.metadata.addWarning(`Ignore ASF-Object-GUID: ${header.objectId.str}`);
					debug("Ignore ASF-Object-GUID: %s", header.objectId.str);
					await this.tokenizer.readToken(new IgnoreObjectState(header));
			}
		} while (--numberOfObjectHeaders);
	}
	async addTags(tags) {
		await Promise.all(tags.map(({ id, value }) => this.metadata.addTag(headerType, id, value)));
	}
	async parseExtensionObject(extensionSize) {
		do {
			const header = await this.tokenizer.readToken(HeaderObjectToken);
			const remaining = header.objectSize - HeaderObjectToken.len;
			if (remaining < 0) {throw new AsfContentParseError(`Invalid ASF header object size: ${header.objectSize}`);}
			switch (header.objectId.str) {
				case ExtendedStreamPropertiesObjectState.guid.str:
					await this.tokenizer.readToken(new ExtendedStreamPropertiesObjectState(header));
					break;
				case MetadataObjectState.guid.str: {
					const moTags = await this.tokenizer.readToken(new MetadataObjectState(header));
					await this.addTags(moTags);
					break;
				}
				case MetadataLibraryObjectState.guid.str: {
					const mlTags = await this.tokenizer.readToken(new MetadataLibraryObjectState(header));
					await this.addTags(mlTags);
					break;
				}
				case AsfGuid.PaddingObject.str:
					await this.tokenizer.ignore(remaining);
					break;
				case AsfGuid.CompatibilityObject.str:
					await this.tokenizer.ignore(remaining);
					break;
				case AsfGuid.ASF_Index_Placeholder_Object.str:
					await this.tokenizer.ignore(remaining);
					break;
				default:
					this.metadata.addWarning(`Ignore ASF-Object-GUID: ${header.objectId.str}`);
					await this.tokenizer.readToken(new IgnoreObjectState(header));
					break;
			}
			extensionSize -= header.objectSize;
		} while (extensionSize > 0);
	}
};
//#endregion
export { AsfParser };
