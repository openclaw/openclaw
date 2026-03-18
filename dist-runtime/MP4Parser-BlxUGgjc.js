import { o as __toESM } from "./chunk-DORXReHP.js";
import { t as require_src } from "./src-BRI-p-42.js";
import { D as Uint8ArrayType, E as UINT8, O as lib_exports, S as UINT32_BE, _ as StringType, b as UINT24_BE, d as INT24_BE, f as INT32_BE, g as INT8, k as textDecode, s as makeUnexpectedFileContentError, t as BasicParser, u as INT16_BE, v as UINT16_BE, w as UINT64_BE } from "./BasicParser-8KWEbE2n.js";
import "./lib-DAan1wcL.js";
import { a as getBit, d as uint8ArrayToHex } from "./Util-BlzR3DP9.js";
import { i as FourCcToken } from "./APEv2Parser-CNS1xDuS.js";
import { t as Genres } from "./ID3v1Parser-DbCyO3hq.js";
import { n as TrackType } from "./types-C43RDR0m.js";
//#region node_modules/.pnpm/music-metadata@11.12.1/node_modules/music-metadata/lib/mp4/AtomToken.js
var import_src = /* @__PURE__ */ __toESM(require_src(), 1);
const debug$2 = (0, import_src.default)("music-metadata:parser:MP4:atom");
var Mp4ContentError = class extends makeUnexpectedFileContentError("MP4") {};
const Header = {
	len: 8,
	get: (buf, off) => {
		const length = UINT32_BE.get(buf, off);
		if (length < 0) throw new Mp4ContentError("Invalid atom header length");
		return {
			length: BigInt(length),
			name: new StringType(4, "latin1").get(buf, off + 4)
		};
	},
	put: (buf, off, hdr) => {
		UINT32_BE.put(buf, off, Number(hdr.length));
		return FourCcToken.put(buf, off + 4, hdr.name);
	}
};
/**
* Ref: https://developer.apple.com/library/archive/documentation/QuickTime/QTFF/QTFFChap1/qtff1.html#//apple_ref/doc/uid/TP40000939-CH203-38190
*/
const ExtendedSize = UINT64_BE;
const ftyp = {
	len: 4,
	get: (buf, off) => {
		return { type: new StringType(4, "ascii").get(buf, off) };
	}
};
/**
* Base class for 'fixed' length atoms.
* In some cases these atoms are longer then the sum of the described fields.
* Issue: https://github.com/Borewit/music-metadata/issues/120
*/
var FixedLengthAtom = class {
	/**
	*
	* @param {number} len Length as specified in the size field
	* @param {number} expLen Total length of sum of specified fields in the standard
	* @param atomId Atom ID
	*/
	constructor(len, expLen, atomId) {
		if (len < expLen) throw new Mp4ContentError(`Atom ${atomId} expected to be ${expLen}, but specifies ${len} bytes long.`);
		if (len > expLen) debug$2(`Warning: atom ${atomId} expected to be ${expLen}, but was actually ${len} bytes long.`);
		this.len = len;
	}
};
/**
* Timestamp stored in seconds since Mac Epoch (1 January 1904)
*/
const SecondsSinceMacEpoch = {
	len: 4,
	get: (buf, off) => {
		const secondsSinceUnixEpoch = UINT32_BE.get(buf, off) - 2082844800;
		return /* @__PURE__ */ new Date(secondsSinceUnixEpoch * 1e3);
	}
};
/**
* Token: Media Header Atom
* Ref:
* - https://developer.apple.com/library/archive/documentation/QuickTime/QTFF/QTFFChap2/qtff2.html#//apple_ref/doc/uid/TP40000939-CH204-SW34
* - https://wiki.multimedia.cx/index.php/QuickTime_container#mdhd
*/
var MdhdAtom = class extends FixedLengthAtom {
	constructor(len) {
		super(len, 24, "mdhd");
	}
	get(buf, off) {
		return {
			version: UINT8.get(buf, off + 0),
			flags: UINT24_BE.get(buf, off + 1),
			creationTime: SecondsSinceMacEpoch.get(buf, off + 4),
			modificationTime: SecondsSinceMacEpoch.get(buf, off + 8),
			timeScale: UINT32_BE.get(buf, off + 12),
			duration: UINT32_BE.get(buf, off + 16),
			language: UINT16_BE.get(buf, off + 20),
			quality: UINT16_BE.get(buf, off + 22)
		};
	}
};
/**
* Token: Movie Header Atom
*/
var MvhdAtom = class extends FixedLengthAtom {
	constructor(len) {
		super(len, 100, "mvhd");
	}
	get(buf, off) {
		return {
			version: UINT8.get(buf, off),
			flags: UINT24_BE.get(buf, off + 1),
			creationTime: SecondsSinceMacEpoch.get(buf, off + 4),
			modificationTime: SecondsSinceMacEpoch.get(buf, off + 8),
			timeScale: UINT32_BE.get(buf, off + 12),
			duration: UINT32_BE.get(buf, off + 16),
			preferredRate: UINT32_BE.get(buf, off + 20),
			preferredVolume: UINT16_BE.get(buf, off + 24),
			previewTime: UINT32_BE.get(buf, off + 72),
			previewDuration: UINT32_BE.get(buf, off + 76),
			posterTime: UINT32_BE.get(buf, off + 80),
			selectionTime: UINT32_BE.get(buf, off + 84),
			selectionDuration: UINT32_BE.get(buf, off + 88),
			currentTime: UINT32_BE.get(buf, off + 92),
			nextTrackID: UINT32_BE.get(buf, off + 96)
		};
	}
};
/**
* Data Atom Structure
*/
var DataAtom = class {
	constructor(len) {
		this.len = len;
	}
	get(buf, off) {
		return {
			type: {
				set: UINT8.get(buf, off + 0),
				type: UINT24_BE.get(buf, off + 1)
			},
			locale: UINT24_BE.get(buf, off + 4),
			value: new Uint8ArrayType(this.len - 8).get(buf, off + 8)
		};
	}
};
/**
* Data Atom Structure
* Ref: https://developer.apple.com/library/content/documentation/QuickTime/QTFF/Metadata/Metadata.html#//apple_ref/doc/uid/TP40000939-CH1-SW31
*/
var NameAtom = class {
	constructor(len) {
		this.len = len;
	}
	get(buf, off) {
		return {
			version: UINT8.get(buf, off),
			flags: UINT24_BE.get(buf, off + 1),
			name: new StringType(this.len - 4, "utf-8").get(buf, off + 4)
		};
	}
};
/**
* Track Header Atoms structure (`tkhd`)
* Ref: https://developer.apple.com/library/content/documentation/QuickTime/QTFF/QTFFChap2/qtff2.html#//apple_ref/doc/uid/TP40000939-CH204-25550
*/
var TrackHeaderAtom = class {
	constructor(len) {
		this.len = len;
	}
	get(buf, off) {
		return {
			version: UINT8.get(buf, off),
			flags: UINT24_BE.get(buf, off + 1),
			creationTime: SecondsSinceMacEpoch.get(buf, off + 4),
			modificationTime: SecondsSinceMacEpoch.get(buf, off + 8),
			trackId: UINT32_BE.get(buf, off + 12),
			duration: UINT32_BE.get(buf, off + 20),
			layer: UINT16_BE.get(buf, off + 24),
			alternateGroup: UINT16_BE.get(buf, off + 26),
			volume: UINT16_BE.get(buf, off + 28)
		};
	}
};
/**
* Atom: Sample Description Atom ('stsd')
* Ref: https://developer.apple.com/library/archive/documentation/QuickTime/QTFF/QTFFChap2/qtff2.html#//apple_ref/doc/uid/TP40000939-CH204-25691
*/
const stsdHeader = {
	len: 8,
	get: (buf, off) => {
		return {
			version: UINT8.get(buf, off),
			flags: UINT24_BE.get(buf, off + 1),
			numberOfEntries: UINT32_BE.get(buf, off + 4)
		};
	}
};
/**
* Atom: Sample Description Atom ('stsd')
* Ref: https://developer.apple.com/documentation/quicktime-file-format/sample_description_atom
*/
var SampleDescriptionTable = class {
	constructor(len) {
		this.len = len;
	}
	get(buf, off) {
		const descrLen = this.len - 12;
		return {
			dataFormat: FourCcToken.get(buf, off),
			dataReferenceIndex: UINT16_BE.get(buf, off + 10),
			description: descrLen > 0 ? new Uint8ArrayType(descrLen).get(buf, off + 12) : void 0
		};
	}
};
/**
* Atom: Sample-description Atom ('stsd')
* Ref: https://developer.apple.com/library/archive/documentation/QuickTime/QTFF/QTFFChap2/qtff2.html#//apple_ref/doc/uid/TP40000939-CH204-25691
*/
var StsdAtom = class {
	constructor(len) {
		this.len = len;
	}
	get(buf, off) {
		const header = stsdHeader.get(buf, off);
		off += stsdHeader.len;
		const table = [];
		for (let n = 0; n < header.numberOfEntries; ++n) {
			const size = UINT32_BE.get(buf, off);
			off += UINT32_BE.len;
			table.push(new SampleDescriptionTable(size - UINT32_BE.len).get(buf, off));
			off += size;
		}
		return {
			header,
			table
		};
	}
};
/**
* Common Sound Sample Description (version & revision)
* Ref: https://developer.apple.com/library/archive/documentation/QuickTime/QTFF/QTFFChap3/qtff3.html#//apple_ref/doc/uid/TP40000939-CH205-57317
*/
const SoundSampleDescriptionVersion = {
	len: 8,
	get(buf, off) {
		return {
			version: INT16_BE.get(buf, off),
			revision: INT16_BE.get(buf, off + 2),
			vendor: INT32_BE.get(buf, off + 4)
		};
	}
};
/**
* Sound Sample Description (Version 0)
* Ref: https://developer.apple.com/library/archive/documentation/QuickTime/QTFF/QTFFChap3/qtff3.html#//apple_ref/doc/uid/TP40000939-CH205-130736
*/
const SoundSampleDescriptionV0 = {
	len: 12,
	get(buf, off) {
		return {
			numAudioChannels: INT16_BE.get(buf, off + 0),
			sampleSize: INT16_BE.get(buf, off + 2),
			compressionId: INT16_BE.get(buf, off + 4),
			packetSize: INT16_BE.get(buf, off + 6),
			sampleRate: UINT16_BE.get(buf, off + 8) + UINT16_BE.get(buf, off + 10) / 1e4
		};
	}
};
var SimpleTableAtom = class {
	constructor(len, token) {
		this.len = len;
		this.token = token;
	}
	get(buf, off) {
		const nrOfEntries = INT32_BE.get(buf, off + 4);
		return {
			version: INT8.get(buf, off + 0),
			flags: INT24_BE.get(buf, off + 1),
			numberOfEntries: nrOfEntries,
			entries: readTokenTable(buf, this.token, off + 8, this.len - 8, nrOfEntries)
		};
	}
};
const TimeToSampleToken = {
	len: 8,
	get(buf, off) {
		return {
			count: INT32_BE.get(buf, off + 0),
			duration: INT32_BE.get(buf, off + 4)
		};
	}
};
/**
* Time-to-sample('stts') atom.
* Store duration information for a media’s samples.
* Ref: https://developer.apple.com/library/archive/documentation/QuickTime/QTFF/QTFFChap2/qtff2.html#//apple_ref/doc/uid/TP40000939-CH204-25696
*/
var SttsAtom = class extends SimpleTableAtom {
	constructor(len) {
		super(len, TimeToSampleToken);
	}
};
const SampleToChunkToken = {
	len: 12,
	get(buf, off) {
		return {
			firstChunk: INT32_BE.get(buf, off),
			samplesPerChunk: INT32_BE.get(buf, off + 4),
			sampleDescriptionId: INT32_BE.get(buf, off + 8)
		};
	}
};
/**
* Sample-to-Chunk ('stsc') atom interface
* Ref: https://developer.apple.com/library/archive/documentation/QuickTime/QTFF/QTFFChap2/qtff2.html#//apple_ref/doc/uid/TP40000939-CH204-25706
*/
var StscAtom = class extends SimpleTableAtom {
	constructor(len) {
		super(len, SampleToChunkToken);
	}
};
/**
* Sample-size ('stsz') atom
* Ref: https://developer.apple.com/library/archive/documentation/QuickTime/QTFF/QTFFChap2/qtff2.html#//apple_ref/doc/uid/TP40000939-CH204-25710
*/
var StszAtom = class {
	constructor(len) {
		this.len = len;
	}
	get(buf, off) {
		const nrOfEntries = INT32_BE.get(buf, off + 8);
		return {
			version: INT8.get(buf, off),
			flags: INT24_BE.get(buf, off + 1),
			sampleSize: INT32_BE.get(buf, off + 4),
			numberOfEntries: nrOfEntries,
			entries: readTokenTable(buf, INT32_BE, off + 12, this.len - 12, nrOfEntries)
		};
	}
};
/**
* Chunk offset atom, 'stco'
* Ref: https://developer.apple.com/library/archive/documentation/QuickTime/QTFF/QTFFChap2/qtff2.html#//apple_ref/doc/uid/TP40000939-CH204-25715
*/
var StcoAtom = class extends SimpleTableAtom {
	constructor(len) {
		super(len, INT32_BE);
		this.len = len;
	}
};
/**
* Token used to decode text-track from 'mdat' atom (raw data stream)
*/
var ChapterText = class {
	constructor(len) {
		this.len = len;
	}
	get(buf, off) {
		return new StringType(INT16_BE.get(buf, off + 0), "utf-8").get(buf, off + 2);
	}
};
function readTokenTable(buf, token, off, remainingLen, numberOfEntries) {
	debug$2(`remainingLen=${remainingLen}, numberOfEntries=${numberOfEntries} * token-len=${token.len}`);
	if (remainingLen === 0) return [];
	if (remainingLen !== numberOfEntries * token.len) throw new Mp4ContentError("mismatch number-of-entries with remaining atom-length");
	const entries = [];
	for (let n = 0; n < numberOfEntries; ++n) {
		entries.push(token.get(buf, off));
		off += token.len;
	}
	return entries;
}
/**
* Sample-size ('tfhd') TrackFragmentHeaderBox
*/
var TrackFragmentHeaderBox = class {
	constructor(len) {
		this.len = len;
	}
	get(buf, off) {
		const flagOffset = off + 1;
		const header = {
			version: INT8.get(buf, off),
			flags: {
				baseDataOffsetPresent: getBit(buf, flagOffset + 2, 0),
				sampleDescriptionIndexPresent: getBit(buf, flagOffset + 2, 1),
				defaultSampleDurationPresent: getBit(buf, flagOffset + 2, 3),
				defaultSampleSizePresent: getBit(buf, flagOffset + 2, 4),
				defaultSampleFlagsPresent: getBit(buf, flagOffset + 2, 5),
				defaultDurationIsEmpty: getBit(buf, flagOffset, 0),
				defaultBaseIsMoof: getBit(buf, flagOffset, 1)
			},
			trackId: UINT32_BE.get(buf, 4)
		};
		let dynOffset = 8;
		if (header.flags.baseDataOffsetPresent) {
			header.baseDataOffset = UINT64_BE.get(buf, dynOffset);
			dynOffset += 8;
		}
		if (header.flags.sampleDescriptionIndexPresent) {
			header.sampleDescriptionIndex = UINT32_BE.get(buf, dynOffset);
			dynOffset += 4;
		}
		if (header.flags.defaultSampleDurationPresent) {
			header.defaultSampleDuration = UINT32_BE.get(buf, dynOffset);
			dynOffset += 4;
		}
		if (header.flags.defaultSampleSizePresent) {
			header.defaultSampleSize = UINT32_BE.get(buf, dynOffset);
			dynOffset += 4;
		}
		if (header.flags.defaultSampleFlagsPresent) header.defaultSampleFlags = UINT32_BE.get(buf, dynOffset);
		return header;
	}
};
/**
* Sample-size ('trun') TrackRunBox
*/
var TrackRunBox = class {
	constructor(len) {
		this.len = len;
	}
	get(buf, off) {
		const flagOffset = off + 1;
		const trun = {
			version: INT8.get(buf, off),
			flags: {
				dataOffsetPresent: getBit(buf, flagOffset + 2, 0),
				firstSampleFlagsPresent: getBit(buf, flagOffset + 2, 2),
				sampleDurationPresent: getBit(buf, flagOffset + 1, 0),
				sampleSizePresent: getBit(buf, flagOffset + 1, 1),
				sampleFlagsPresent: getBit(buf, flagOffset + 1, 2),
				sampleCompositionTimeOffsetsPresent: getBit(buf, flagOffset + 1, 3)
			},
			sampleCount: UINT32_BE.get(buf, off + 4),
			samples: []
		};
		let dynOffset = off + 8;
		if (trun.flags.dataOffsetPresent) {
			trun.dataOffset = UINT32_BE.get(buf, dynOffset);
			dynOffset += 4;
		}
		if (trun.flags.firstSampleFlagsPresent) {
			trun.firstSampleFlags = UINT32_BE.get(buf, dynOffset);
			dynOffset += 4;
		}
		for (let n = 0; n < trun.sampleCount; ++n) {
			if (dynOffset >= this.len) {
				debug$2("TrackRunBox size mismatch");
				break;
			}
			const sample = {};
			if (trun.flags.sampleDurationPresent) {
				sample.sampleDuration = UINT32_BE.get(buf, dynOffset);
				dynOffset += 4;
			}
			if (trun.flags.sampleSizePresent) {
				sample.sampleSize = UINT32_BE.get(buf, dynOffset);
				dynOffset += 4;
			}
			if (trun.flags.sampleFlagsPresent) {
				sample.sampleFlags = UINT32_BE.get(buf, dynOffset);
				dynOffset += 4;
			}
			if (trun.flags.sampleCompositionTimeOffsetsPresent) {
				sample.sampleCompositionTimeOffset = UINT32_BE.get(buf, dynOffset);
				dynOffset += 4;
			}
			trun.samples.push(sample);
		}
		return trun;
	}
};
/**
* HandlerBox (`hdlr`)
*/
var HandlerBox = class {
	constructor(len) {
		this.len = len;
	}
	get(buf, off) {
		off + 1;
		const charTypeToken = new StringType(4, "utf-8");
		return {
			version: INT8.get(buf, off),
			flags: UINT24_BE.get(buf, off + 1),
			componentType: charTypeToken.get(buf, off + 4),
			handlerType: charTypeToken.get(buf, off + 8),
			componentName: new StringType(this.len - 28, "utf-8").get(buf, off + 28)
		};
	}
};
/**
* Chapter Track Reference Box (`chap`)
*/
var ChapterTrackReferenceBox = class {
	constructor(len) {
		this.len = len;
	}
	get(buf, off) {
		let dynOffset = 0;
		const trackIds = [];
		while (dynOffset < this.len) {
			trackIds.push(UINT32_BE.get(buf, off + dynOffset));
			dynOffset += 4;
		}
		return trackIds;
	}
};
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.1/node_modules/music-metadata/lib/mp4/Atom.js
const debug$1 = (0, import_src.default)("music-metadata:parser:MP4:Atom");
var Atom = class Atom {
	static async readAtom(tokenizer, dataHandler, parent, remaining) {
		const offset = tokenizer.position;
		debug$1(`Reading next token on offset=${offset}...`);
		const header = await tokenizer.readToken(Header);
		const extended = header.length === 1n;
		if (extended) header.length = await tokenizer.readToken(ExtendedSize);
		const atomBean = new Atom(header, extended, parent);
		const payloadLength = atomBean.getPayloadLength(remaining);
		debug$1(`parse atom name=${atomBean.atomPath}, extended=${atomBean.extended}, offset=${offset}, len=${atomBean.header.length}`);
		await atomBean.readData(tokenizer, dataHandler, payloadLength);
		return atomBean;
	}
	constructor(header, extended, parent) {
		this.header = header;
		this.extended = extended;
		this.parent = parent;
		this.children = [];
		this.atomPath = (this.parent ? `${this.parent.atomPath}.` : "") + this.header.name;
	}
	getHeaderLength() {
		return this.extended ? 16 : 8;
	}
	getPayloadLength(remaining) {
		return (this.header.length === 0n ? remaining : Number(this.header.length)) - this.getHeaderLength();
	}
	async readAtoms(tokenizer, dataHandler, size) {
		while (size > 0) {
			const atomBean = await Atom.readAtom(tokenizer, dataHandler, this, size);
			this.children.push(atomBean);
			size -= atomBean.header.length === 0n ? size : Number(atomBean.header.length);
		}
	}
	async readData(tokenizer, dataHandler, remaining) {
		switch (this.header.name) {
			case "moov":
			case "udta":
			case "mdia":
			case "minf":
			case "stbl":
			case "<id>":
			case "ilst":
			case "tref":
			case "moof": return this.readAtoms(tokenizer, dataHandler, this.getPayloadLength(remaining));
			case "meta": {
				const paddingLength = (await tokenizer.peekToken(Header)).name === "hdlr" ? 0 : 4;
				await tokenizer.ignore(paddingLength);
				return this.readAtoms(tokenizer, dataHandler, this.getPayloadLength(remaining) - paddingLength);
			}
			default: return dataHandler(this, remaining);
		}
	}
};
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.1/node_modules/music-metadata/lib/mp4/MP4Parser.js
const debug = (0, import_src.default)("music-metadata:parser:MP4");
const tagFormat = "iTunes";
const encoderDict = {
	raw: {
		lossy: false,
		format: "raw"
	},
	MAC3: {
		lossy: true,
		format: "MACE 3:1"
	},
	MAC6: {
		lossy: true,
		format: "MACE 6:1"
	},
	ima4: {
		lossy: true,
		format: "IMA 4:1"
	},
	ulaw: {
		lossy: true,
		format: "uLaw 2:1"
	},
	alaw: {
		lossy: true,
		format: "uLaw 2:1"
	},
	Qclp: {
		lossy: true,
		format: "QUALCOMM PureVoice"
	},
	".mp3": {
		lossy: true,
		format: "MPEG-1 layer 3"
	},
	alac: {
		lossy: false,
		format: "ALAC"
	},
	"ac-3": {
		lossy: true,
		format: "AC-3"
	},
	mp4a: {
		lossy: true,
		format: "MPEG-4/AAC"
	},
	mp4s: {
		lossy: true,
		format: "MP4S"
	},
	c608: {
		lossy: true,
		format: "CEA-608"
	},
	c708: {
		lossy: true,
		format: "CEA-708"
	}
};
function distinct(value, index, self) {
	return self.indexOf(value) === index;
}
var MP4Parser = class MP4Parser extends BasicParser {
	constructor() {
		super(...arguments);
		this.tracks = /* @__PURE__ */ new Map();
		this.hasVideoTrack = false;
		this.hasAudioTrack = true;
		this.atomParsers = {
			mvhd: async (len) => {
				const mvhd = await this.tokenizer.readToken(new MvhdAtom(len));
				this.metadata.setFormat("creationTime", mvhd.creationTime);
				this.metadata.setFormat("modificationTime", mvhd.modificationTime);
			},
			chap: async (len) => {
				const td = this.getTrackDescription();
				const trackIds = [];
				while (len >= UINT32_BE.len) {
					trackIds.push(await this.tokenizer.readNumber(UINT32_BE));
					len -= UINT32_BE.len;
				}
				td.chapterList = trackIds;
			},
			mdat: async (len) => {
				if (this.options.includeChapters) {
					const trackWithChapters = [...this.tracks.values()].filter((track) => track.chapterList);
					if (trackWithChapters.length === 1) {
						const chapterTrackIds = trackWithChapters[0].chapterList;
						const chapterTracks = [...this.tracks.values()].filter((track) => chapterTrackIds.indexOf(track.header.trackId) !== -1);
						if (chapterTracks.length === 1) return this.parseChapterTrack(chapterTracks[0], trackWithChapters[0], len);
					}
				}
				await this.tokenizer.ignore(len);
			},
			ftyp: async (len) => {
				const types = [];
				while (len > 0) {
					const ftype = await this.tokenizer.readToken(ftyp);
					len -= ftyp.len;
					const value = ftype.type.replace(/\W/g, "");
					if (value.length > 0) types.push(value);
				}
				debug(`ftyp: ${types.join("/")}`);
				const x = types.filter(distinct).join("/");
				this.metadata.setFormat("container", x);
			},
			stsd: async (len) => {
				const stsd = await this.tokenizer.readToken(new StsdAtom(len));
				const trackDescription = this.getTrackDescription();
				trackDescription.soundSampleDescription = stsd.table.map((dfEntry) => this.parseSoundSampleDescription(dfEntry));
			},
			stsz: async (len) => {
				const stsz = await this.tokenizer.readToken(new StszAtom(len));
				const td = this.getTrackDescription();
				td.sampleSize = stsz.sampleSize;
				td.sampleSizeTable = stsz.entries;
			},
			date: async (len) => {
				const date = await this.tokenizer.readToken(new StringType(len, "utf-8"));
				await this.addTag("date", date);
			}
		};
	}
	static read_BE_Integer(array, signed) {
		const integerType = (signed ? "INT" : "UINT") + array.length * 8 + (array.length > 1 ? "_BE" : "");
		const token = lib_exports[integerType];
		if (!token) throw new Mp4ContentError(`Token for integer type not found: "${integerType}"`);
		return Number(token.get(array, 0));
	}
	async parse() {
		this.hasVideoTrack = false;
		this.hasAudioTrack = true;
		this.tracks.clear();
		let remainingFileSize = this.tokenizer.fileInfo.size || 0;
		while (!this.tokenizer.fileInfo.size || remainingFileSize > 0) {
			try {
				if ((await this.tokenizer.peekToken(Header)).name === "\0\0\0\0") {
					const errMsg = `Error at offset=${this.tokenizer.position}: box.id=0`;
					debug(errMsg);
					this.addWarning(errMsg);
					break;
				}
			} catch (error) {
				if (error instanceof Error) {
					const errMsg = `Error at offset=${this.tokenizer.position}: ${error.message}`;
					debug(errMsg);
					this.addWarning(errMsg);
				} else throw error;
				break;
			}
			const rootAtom = await Atom.readAtom(this.tokenizer, (atom, remaining) => this.handleAtom(atom, remaining), null, remainingFileSize);
			remainingFileSize -= rootAtom.header.length === BigInt(0) ? remainingFileSize : Number(rootAtom.header.length);
		}
		const formatList = [];
		this.tracks.forEach((track) => {
			const trackFormats = [];
			track.soundSampleDescription.forEach((ssd) => {
				const streamInfo = {};
				const encoderInfo = encoderDict[ssd.dataFormat];
				if (encoderInfo) {
					trackFormats.push(encoderInfo.format);
					streamInfo.codecName = encoderInfo.format;
				} else streamInfo.codecName = `<${ssd.dataFormat}>`;
				if (ssd.description) {
					const { description } = ssd;
					if (description.sampleRate > 0) {
						streamInfo.type = TrackType.audio;
						streamInfo.audio = {
							samplingFrequency: description.sampleRate,
							bitDepth: description.sampleSize,
							channels: description.numAudioChannels
						};
					}
				}
				this.metadata.addStreamInfo(streamInfo);
			});
			if (trackFormats.length >= 1) formatList.push(trackFormats.join("/"));
		});
		if (formatList.length > 0) this.metadata.setFormat("codec", formatList.filter(distinct).join("+"));
		const audioTracks = [...this.tracks.values()].filter((track) => {
			return track.soundSampleDescription.length >= 1 && track.soundSampleDescription[0].description && track.soundSampleDescription[0].description.numAudioChannels > 0;
		});
		for (const audioTrack of audioTracks) {
			if (audioTrack.media.header && audioTrack.media.header.timeScale > 0) {
				audioTrack.sampleRate = audioTrack.media.header.timeScale;
				if (audioTrack.media.header.duration > 0) {
					debug("Using duration defined on audio track");
					audioTrack.samples = audioTrack.media.header.duration;
					audioTrack.duration = audioTrack.samples / audioTrack.sampleRate;
				}
				if (audioTrack.fragments.length > 0) {
					debug("Calculate duration defined in track fragments");
					let totalTimeUnits = 0;
					audioTrack.sizeInBytes = 0;
					for (const fragment of audioTrack.fragments) for (const sample of fragment.trackRun.samples) {
						const dur = sample.sampleDuration ?? fragment.header.defaultSampleDuration ?? 0;
						const size = sample.sampleSize ?? fragment.header.defaultSampleSize ?? 0;
						if (dur === 0) throw new Error("Missing sampleDuration and no defaultSampleDuration in track fragment header");
						if (size === 0) throw new Error("Missing sampleSize and no defaultSampleSize in track fragment header");
						totalTimeUnits += dur;
						audioTrack.sizeInBytes += size;
					}
					if (!audioTrack.samples) audioTrack.samples = totalTimeUnits;
					if (!audioTrack.duration) audioTrack.duration = totalTimeUnits / audioTrack.sampleRate;
				} else if (audioTrack.sampleSizeTable.length > 0) audioTrack.sizeInBytes = audioTrack.sampleSizeTable.reduce((sum, n) => sum + n, 0);
			}
			const ssd = audioTrack.soundSampleDescription[0];
			if (ssd.description && audioTrack.media.header) {
				this.metadata.setFormat("sampleRate", ssd.description.sampleRate);
				this.metadata.setFormat("bitsPerSample", ssd.description.sampleSize);
				this.metadata.setFormat("numberOfChannels", ssd.description.numAudioChannels);
				if (audioTrack.media.header.timeScale === 0 && audioTrack.timeToSampleTable.length > 0) audioTrack.duration = audioTrack.timeToSampleTable.map((ttstEntry) => ttstEntry.count * ttstEntry.duration).reduce((total, sampleSize) => total + sampleSize) / ssd.description.sampleRate;
			}
			const encoderInfo = encoderDict[ssd.dataFormat];
			if (encoderInfo) this.metadata.setFormat("lossless", !encoderInfo.lossy);
		}
		if (audioTracks.length >= 1) {
			const firstAudioTrack = audioTracks[0];
			if (firstAudioTrack.duration) {
				this.metadata.setFormat("duration", firstAudioTrack.duration);
				if (firstAudioTrack.sizeInBytes) this.metadata.setFormat("bitrate", 8 * firstAudioTrack.sizeInBytes / firstAudioTrack.duration);
			}
		}
		this.metadata.setFormat("hasAudio", this.hasAudioTrack);
		this.metadata.setFormat("hasVideo", this.hasVideoTrack);
	}
	async handleAtom(atom, remaining) {
		if (atom.parent) switch (atom.parent.header.name) {
			case "ilst":
			case "<id>": return this.parseMetadataItemData(atom);
			case "moov":
				switch (atom.header.name) {
					case "trak": return this.parseTrackBox(atom);
					case "udta": return this.parseTrackBox(atom);
				}
				break;
			case "moof": switch (atom.header.name) {
				case "traf": return this.parseTrackFragmentBox(atom);
			}
		}
		if (this.atomParsers[atom.header.name]) return this.atomParsers[atom.header.name](remaining);
		debug(`No parser for atom path=${atom.atomPath}, payload-len=${remaining}, ignoring atom`);
		await this.tokenizer.ignore(remaining);
	}
	getTrackDescription() {
		const tracks = [...this.tracks.values()];
		return tracks[tracks.length - 1];
	}
	async addTag(id, value) {
		await this.metadata.addTag(tagFormat, id, value);
	}
	addWarning(message) {
		debug(`Warning: ${message}`);
		this.metadata.addWarning(message);
	}
	/**
	* Parse data of Meta-item-list-atom (item of 'ilst' atom)
	* @param metaAtom
	* Ref: https://developer.apple.com/library/content/documentation/QuickTime/QTFF/Metadata/Metadata.html#//apple_ref/doc/uid/TP40000939-CH1-SW8
	*/
	parseMetadataItemData(metaAtom) {
		let tagKey = metaAtom.header.name;
		return metaAtom.readAtoms(this.tokenizer, async (child, remaining) => {
			const payLoadLength = child.getPayloadLength(remaining);
			switch (child.header.name) {
				case "data": return this.parseValueAtom(tagKey, child);
				case "name":
				case "mean":
				case "rate": {
					const name = await this.tokenizer.readToken(new NameAtom(payLoadLength));
					tagKey += `:${name.name}`;
					break;
				}
				default: {
					const uint8Array = await this.tokenizer.readToken(new Uint8ArrayType(payLoadLength));
					this.addWarning(`Unsupported meta-item: ${tagKey}[${child.header.name}] => value=${uint8ArrayToHex(uint8Array)} ascii=${textDecode(uint8Array, "ascii")}`);
				}
			}
		}, metaAtom.getPayloadLength(0));
	}
	async parseValueAtom(tagKey, metaAtom) {
		const dataAtom = await this.tokenizer.readToken(new DataAtom(Number(metaAtom.header.length) - Header.len));
		if (dataAtom.type.set !== 0) throw new Mp4ContentError(`Unsupported type-set != 0: ${dataAtom.type.set}`);
		switch (dataAtom.type.type) {
			case 0:
				switch (tagKey) {
					case "trkn":
					case "disk": {
						const num = UINT8.get(dataAtom.value, 3);
						const of = UINT8.get(dataAtom.value, 5);
						await this.addTag(tagKey, `${num}/${of}`);
						break;
					}
					case "gnre": {
						const genreStr = Genres[UINT8.get(dataAtom.value, 1) - 1];
						await this.addTag(tagKey, genreStr);
						break;
					}
					case "rate": {
						const rate = textDecode(dataAtom.value, "ascii");
						await this.addTag(tagKey, rate);
						break;
					}
					default: debug(`unknown proprietary value type for: ${metaAtom.atomPath}`);
				}
				break;
			case 1:
			case 18:
				await this.addTag(tagKey, textDecode(dataAtom.value));
				break;
			case 13:
				if (this.options.skipCovers) break;
				await this.addTag(tagKey, {
					format: "image/jpeg",
					data: Uint8Array.from(dataAtom.value)
				});
				break;
			case 14:
				if (this.options.skipCovers) break;
				await this.addTag(tagKey, {
					format: "image/png",
					data: Uint8Array.from(dataAtom.value)
				});
				break;
			case 21:
				await this.addTag(tagKey, MP4Parser.read_BE_Integer(dataAtom.value, true));
				break;
			case 22:
				await this.addTag(tagKey, MP4Parser.read_BE_Integer(dataAtom.value, false));
				break;
			case 65:
				await this.addTag(tagKey, UINT8.get(dataAtom.value, 0));
				break;
			case 66:
				await this.addTag(tagKey, UINT16_BE.get(dataAtom.value, 0));
				break;
			case 67:
				await this.addTag(tagKey, UINT32_BE.get(dataAtom.value, 0));
				break;
			default: this.addWarning(`atom key=${tagKey}, has unknown well-known-type (data-type): ${dataAtom.type.type}`);
		}
	}
	async parseTrackBox(trakBox) {
		const track = {
			media: {},
			fragments: []
		};
		await trakBox.readAtoms(this.tokenizer, async (child, remaining) => {
			const payLoadLength = child.getPayloadLength(remaining);
			switch (child.header.name) {
				case "chap":
					track.chapterList = await this.tokenizer.readToken(new ChapterTrackReferenceBox(remaining));
					break;
				case "tkhd":
					track.header = await this.tokenizer.readToken(new TrackHeaderAtom(payLoadLength));
					break;
				case "hdlr":
					track.handler = await this.tokenizer.readToken(new HandlerBox(payLoadLength));
					track.isAudio = () => track.handler.handlerType === "audi" || track.handler.handlerType === "soun";
					track.isVideo = () => track.handler.handlerType === "vide";
					if (track.isAudio()) this.hasAudioTrack = true;
					else if (track.isVideo()) this.hasVideoTrack = true;
					break;
				case "mdhd": {
					const mdhd_data = await this.tokenizer.readToken(new MdhdAtom(payLoadLength));
					track.media.header = mdhd_data;
					break;
				}
				case "stco":
					track.chunkOffsetTable = (await this.tokenizer.readToken(new StcoAtom(payLoadLength))).entries;
					break;
				case "stsc":
					track.sampleToChunkTable = (await this.tokenizer.readToken(new StscAtom(payLoadLength))).entries;
					break;
				case "stsd":
					track.soundSampleDescription = (await this.tokenizer.readToken(new StsdAtom(payLoadLength))).table.map((dfEntry) => this.parseSoundSampleDescription(dfEntry));
					break;
				case "stts":
					track.timeToSampleTable = (await this.tokenizer.readToken(new SttsAtom(payLoadLength))).entries;
					break;
				case "stsz": {
					const stsz = await this.tokenizer.readToken(new StszAtom(payLoadLength));
					track.sampleSize = stsz.sampleSize;
					track.sampleSizeTable = stsz.entries;
					break;
				}
				case "dinf":
				case "vmhd":
				case "smhd":
					debug(`Ignoring: ${child.header.name}`);
					await this.tokenizer.ignore(payLoadLength);
					break;
				default:
					debug(`Unexpected track box: ${child.header.name}`);
					await this.tokenizer.ignore(payLoadLength);
			}
		}, trakBox.getPayloadLength(0));
		this.tracks.set(track.header.trackId, track);
	}
	parseTrackFragmentBox(trafBox) {
		let tfhd;
		return trafBox.readAtoms(this.tokenizer, async (child, remaining) => {
			const payLoadLength = child.getPayloadLength(remaining);
			switch (child.header.name) {
				case "tfhd": {
					const fragmentHeaderBox = new TrackFragmentHeaderBox(child.getPayloadLength(remaining));
					tfhd = await this.tokenizer.readToken(fragmentHeaderBox);
					break;
				}
				case "tfdt":
					await this.tokenizer.ignore(payLoadLength);
					break;
				case "trun": {
					const trackRunBox = new TrackRunBox(payLoadLength);
					const trun = await this.tokenizer.readToken(trackRunBox);
					if (tfhd) this.tracks.get(tfhd.trackId)?.fragments.push({
						header: tfhd,
						trackRun: trun
					});
					break;
				}
				default:
					debug(`Unexpected box: ${child.header.name}`);
					await this.tokenizer.ignore(payLoadLength);
			}
		}, trafBox.getPayloadLength(0));
	}
	/**
	* @param sampleDescription
	* Ref: https://developer.apple.com/library/archive/documentation/QuickTime/QTFF/QTFFChap3/qtff3.html#//apple_ref/doc/uid/TP40000939-CH205-128916
	*/
	parseSoundSampleDescription(sampleDescription) {
		const ssd = {
			dataFormat: sampleDescription.dataFormat,
			dataReferenceIndex: sampleDescription.dataReferenceIndex
		};
		let offset = 0;
		if (sampleDescription.description) {
			const version = SoundSampleDescriptionVersion.get(sampleDescription.description, offset);
			offset += SoundSampleDescriptionVersion.len;
			if (version.version === 0 || version.version === 1) ssd.description = SoundSampleDescriptionV0.get(sampleDescription.description, offset);
			else debug(`Warning: sound-sample-description ${version} not implemented`);
		}
		return ssd;
	}
	async parseChapterTrack(chapterTrack, track, len) {
		if (!chapterTrack.sampleSize) {
			if (chapterTrack.chunkOffsetTable.length !== chapterTrack.sampleSizeTable.length) throw new Error("Expected equal chunk-offset-table & sample-size-table length.");
		}
		const chapters = [];
		for (let i = 0; i < chapterTrack.chunkOffsetTable.length && len > 0; ++i) {
			const start = chapterTrack.timeToSampleTable.slice(0, i).reduce((acc, cur) => acc + cur.duration, 0);
			const nextChunkLen = chapterTrack.chunkOffsetTable[i] - this.tokenizer.position;
			const sampleSize = chapterTrack.sampleSize > 0 ? chapterTrack.sampleSize : chapterTrack.sampleSizeTable[i];
			len -= nextChunkLen + sampleSize;
			if (len < 0) throw new Mp4ContentError("Chapter chunk exceeding token length");
			await this.tokenizer.ignore(nextChunkLen);
			const title = await this.tokenizer.readToken(new ChapterText(sampleSize));
			debug(`Chapter ${i + 1}: ${title}`);
			const chapter = {
				title,
				timeScale: chapterTrack.media.header ? chapterTrack.media.header.timeScale : 0,
				start,
				sampleOffset: this.findSampleOffset(track, this.tokenizer.position)
			};
			debug(`Chapter title=${chapter.title}, offset=${chapter.sampleOffset}/${track.header.duration}`);
			chapters.push(chapter);
		}
		this.metadata.setFormat("chapters", chapters);
		await this.tokenizer.ignore(len);
	}
	findSampleOffset(track, chapterOffset) {
		let chunkIndex = 0;
		while (chunkIndex < track.chunkOffsetTable.length && track.chunkOffsetTable[chunkIndex] < chapterOffset) ++chunkIndex;
		return this.getChunkDuration(chunkIndex + 1, track);
	}
	getChunkDuration(chunkId, track) {
		let ttsi = 0;
		let ttsc = track.timeToSampleTable[ttsi].count;
		let ttsd = track.timeToSampleTable[ttsi].duration;
		let curChunkId = 1;
		let samplesPerChunk = this.getSamplesPerChunk(curChunkId, track.sampleToChunkTable);
		let totalDuration = 0;
		while (curChunkId < chunkId) {
			const nrOfSamples = Math.min(ttsc, samplesPerChunk);
			totalDuration += nrOfSamples * ttsd;
			ttsc -= nrOfSamples;
			samplesPerChunk -= nrOfSamples;
			if (samplesPerChunk === 0) {
				++curChunkId;
				samplesPerChunk = this.getSamplesPerChunk(curChunkId, track.sampleToChunkTable);
			} else {
				++ttsi;
				ttsc = track.timeToSampleTable[ttsi].count;
				ttsd = track.timeToSampleTable[ttsi].duration;
			}
		}
		return totalDuration;
	}
	getSamplesPerChunk(chunkId, stcTable) {
		for (let i = 0; i < stcTable.length - 1; ++i) if (chunkId >= stcTable[i].firstChunk && chunkId < stcTable[i + 1].firstChunk) return stcTable[i].samplesPerChunk;
		return stcTable[stcTable.length - 1].samplesPerChunk;
	}
};
//#endregion
export { MP4Parser };
