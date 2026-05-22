//#region node_modules/codec-parser/src/constants.js
const symbol = Symbol;
const mappingJoin = ", ";
const channelMappings = (() => {
	const front = "front";
	const side = "side";
	const rear = "rear";
	const left = "left";
	const center = "center";
	const right = "right";
	return [
		"",
		front + " ",
		side + " ",
		rear + " "
	].map((x) => [
		[left, right],
		[
			left,
			right,
			center
		],
		[
			left,
			center,
			right
		],
		[
			center,
			left,
			right
		],
		[center]
	].flatMap((y) => y.map((z) => x + z).join(mappingJoin)));
})();
const monophonic = "monophonic (mono)";
const stereo = "stereo";
const surround = "surround";
const getChannelMapping = (channelCount, ...mappings) => `${[
	monophonic,
	stereo,
	`linear ${surround}`,
	"quadraphonic",
	`5.0 ${surround}`,
	`5.1 ${surround}`,
	`6.1 ${surround}`,
	`7.1 ${surround}`
][channelCount - 1]} (${mappings.join(mappingJoin)})`;
const vorbisOpusChannelMapping = [
	monophonic,
	getChannelMapping(2, channelMappings[0][0]),
	getChannelMapping(3, channelMappings[0][2]),
	getChannelMapping(4, channelMappings[1][0], channelMappings[3][0]),
	getChannelMapping(5, channelMappings[1][2], channelMappings[3][0]),
	getChannelMapping(6, channelMappings[1][2], channelMappings[3][0], "LFE"),
	getChannelMapping(7, channelMappings[1][2], channelMappings[2][0], channelMappings[3][4], "LFE"),
	getChannelMapping(8, channelMappings[1][2], channelMappings[2][0], channelMappings[3][0], "LFE")
];
const rate192000 = 192e3;
const rate176400 = 176400;
const rate96000 = 96e3;
const rate88200 = 88200;
const rate64000 = 64e3;
const rate48000 = 48e3;
const rate44100 = 44100;
const rate32000 = 32e3;
const rate24000 = 24e3;
const rate22050 = 22050;
const rate16000 = 16e3;
const rate12000 = 12e3;
const rate11025 = 11025;
const rate8000 = 8e3;
const rate7350 = 7350;
const absoluteGranulePosition$1 = "absoluteGranulePosition";
const bandwidth = "bandwidth";
const bitDepth = "bitDepth";
const bitrate = "bitrate";
const bitrateMaximum = bitrate + "Maximum";
const bitrateMinimum = bitrate + "Minimum";
const bitrateNominal = bitrate + "Nominal";
const buffer = "buffer";
const bufferFullness = buffer + "Fullness";
const codec = "codec";
const codecFrames$1 = codec + "Frames";
const coupledStreamCount$1 = "coupledStreamCount";
const crc16 = "crc16";
const crc32 = "crc32";
const data$1 = "data";
const description = "description";
const duration = "duration";
const emphasis = "emphasis";
const hasOpusPadding = "hasOpusPadding";
const header$1 = "header";
const isContinuedPacket = "isContinuedPacket";
const isCopyrighted = "isCopyrighted";
const isFirstPage = "isFirstPage";
const isHome = "isHome";
const isLastPage$1 = "isLastPage";
const isOriginal = "isOriginal";
const isPrivate = "isPrivate";
const isVbr = "isVbr";
const layer = "layer";
const length = "length";
const mode = "mode";
const modeExtension = mode + "Extension";
const mpeg = "mpeg";
const mpegVersion = mpeg + "Version";
const numberAACFrames = "numberAACFrames";
const outputGain = "outputGain";
const preSkip$1 = "preSkip";
const profile = "profile";
const profileBits = symbol();
const protection = "protection";
const rawData = "rawData";
const segments = "segments";
const subarray = "subarray";
const version = "version";
const vorbis = "vorbis";
const vorbisComments = vorbis + "Comments";
const vorbisSetup$1 = vorbis + "Setup";
const block = "block";
const blockingStrategy = block + "ingStrategy";
const blockingStrategyBits = symbol();
const blockSize = block + "Size";
const blocksize0 = block + "size0";
const blocksize1 = block + "size1";
const blockSizeBits = symbol();
const channel = "channel";
const channelMappingFamily = channel + "MappingFamily";
const channelMappingTable$1 = channel + "MappingTable";
const channelMode = channel + "Mode";
const channelModeBits = symbol();
const channels$1 = channel + "s";
const copyright = "copyright";
const copyrightId = copyright + "Id";
const copyrightIdStart = copyright + "IdStart";
const frame = "frame";
const frameCount = frame + "Count";
const frameLength = frame + "Length";
const Number$1 = "Number";
const frameNumber = frame + Number$1;
const framePadding = frame + "Padding";
const frameSize = frame + "Size";
const Rate = "Rate";
const inputSampleRate = "inputSample" + Rate;
const page = "page";
const pageChecksum = page + "Checksum";
const pageSegmentBytes = symbol();
const pageSegmentTable = page + "SegmentTable";
const pageSequenceNumber = page + "SequenceNumber";
const sample = "sample";
const sampleNumber = sample + Number$1;
const sampleRate = sample + Rate;
const sampleRateBits = symbol();
const samples = sample + "s";
const stream = "stream";
const streamCount$1 = stream + "Count";
const streamInfo = stream + "Info";
const streamSerialNumber = stream + "SerialNumber";
const streamStructureVersion = stream + "StructureVersion";
const total = "total";
const totalBytesOut = total + "BytesOut";
const totalDuration = total + "Duration";
const totalSamples$1 = total + "Samples";
const readRawData = symbol();
const incrementRawData = symbol();
const mapCodecFrameStats = symbol();
const mapFrameStats = symbol();
const logWarning = symbol();
const logError$1 = symbol();
const syncFrame = symbol();
const fixedLengthFrameSync = symbol();
const getHeader = symbol();
const setHeader = symbol();
const getFrame = symbol();
const parseFrame = symbol();
const parseOggPage = symbol();
const checkCodecUpdate = symbol();
const reset = symbol();
const enable = symbol();
const getHeaderFromUint8Array = symbol();
const checkFrameFooterCrc16 = symbol();
const uint8Array = Uint8Array;
const dataView = DataView;
const reserved = "reserved";
const free = "free";
const none = "none";
const sixteenBitCRC = "16bit CRC";
//#endregion
//#region node_modules/codec-parser/src/utilities.js
const getCrcTable = (crcTable, crcInitialValueFunction, crcFunction) => {
	for (let byte = 0; byte < crcTable[length]; byte++) {
		let crc = crcInitialValueFunction(byte);
		for (let bit = 8; bit > 0; bit--) crc = crcFunction(crc);
		crcTable[byte] = crc;
	}
	return crcTable;
};
const crc8Table = getCrcTable(new uint8Array(256), (b) => b, (crc) => crc & 128 ? 7 ^ crc << 1 : crc << 1);
const flacCrc16Table = [getCrcTable(new Uint16Array(256), (b) => b << 8, (crc) => crc << 1 ^ (crc & 32768 ? 32773 : 0))];
const crc32Table = [getCrcTable(new Uint32Array(256), (b) => b, (crc) => crc >>> 1 ^ (crc & 1) * 3988292384)];
for (let i = 0; i < 15; i++) {
	flacCrc16Table.push(new Uint16Array(256));
	crc32Table.push(new Uint32Array(256));
	for (let j = 0; j <= 255; j++) {
		flacCrc16Table[i + 1][j] = flacCrc16Table[0][flacCrc16Table[i][j] >>> 8] ^ flacCrc16Table[i][j] << 8;
		crc32Table[i + 1][j] = crc32Table[i][j] >>> 8 ^ crc32Table[0][crc32Table[i][j] & 255];
	}
}
const crc8 = (data) => {
	let crc = 0;
	const dataLength = data[length];
	for (let i = 0; i !== dataLength; i++) crc = crc8Table[crc ^ data[i]];
	return crc;
};
const flacCrc16 = (data) => {
	const dataLength = data[length];
	const crcChunkSize = dataLength - 16;
	let crc = 0;
	let i = 0;
	while (i <= crcChunkSize) {
		crc ^= data[i++] << 8 | data[i++];
		crc = flacCrc16Table[15][crc >> 8] ^ flacCrc16Table[14][crc & 255] ^ flacCrc16Table[13][data[i++]] ^ flacCrc16Table[12][data[i++]] ^ flacCrc16Table[11][data[i++]] ^ flacCrc16Table[10][data[i++]] ^ flacCrc16Table[9][data[i++]] ^ flacCrc16Table[8][data[i++]] ^ flacCrc16Table[7][data[i++]] ^ flacCrc16Table[6][data[i++]] ^ flacCrc16Table[5][data[i++]] ^ flacCrc16Table[4][data[i++]] ^ flacCrc16Table[3][data[i++]] ^ flacCrc16Table[2][data[i++]] ^ flacCrc16Table[1][data[i++]] ^ flacCrc16Table[0][data[i++]];
	}
	while (i !== dataLength) crc = (crc & 255) << 8 ^ flacCrc16Table[0][crc >> 8 ^ data[i++]];
	return crc;
};
const crc32Function = (data) => {
	const dataLength = data[length];
	const crcChunkSize = dataLength - 16;
	let crc = 0;
	let i = 0;
	while (i <= crcChunkSize) crc = crc32Table[15][(data[i++] ^ crc) & 255] ^ crc32Table[14][(data[i++] ^ crc >>> 8) & 255] ^ crc32Table[13][(data[i++] ^ crc >>> 16) & 255] ^ crc32Table[12][data[i++] ^ crc >>> 24] ^ crc32Table[11][data[i++]] ^ crc32Table[10][data[i++]] ^ crc32Table[9][data[i++]] ^ crc32Table[8][data[i++]] ^ crc32Table[7][data[i++]] ^ crc32Table[6][data[i++]] ^ crc32Table[5][data[i++]] ^ crc32Table[4][data[i++]] ^ crc32Table[3][data[i++]] ^ crc32Table[2][data[i++]] ^ crc32Table[1][data[i++]] ^ crc32Table[0][data[i++]];
	while (i !== dataLength) crc = crc32Table[0][(crc ^ data[i++]) & 255] ^ crc >>> 8;
	return crc ^ -1;
};
const concatBuffers = (...buffers) => {
	const buffer = new uint8Array(buffers.reduce((acc, buf) => acc + buf[length], 0));
	buffers.reduce((offset, buf) => {
		buffer.set(buf, offset);
		return offset + buf[length];
	}, 0);
	return buffer;
};
const bytesToString = (bytes) => String.fromCharCode(...bytes);
const reverseTable = [
	0,
	8,
	4,
	12,
	2,
	10,
	6,
	14,
	1,
	9,
	5,
	13,
	3,
	11,
	7,
	15
];
const reverse = (val) => reverseTable[val & 15] << 4 | reverseTable[val >> 4];
var BitReader = class {
	constructor(data) {
		this._data = data;
		this._pos = data[length] * 8;
	}
	set position(position) {
		this._pos = position;
	}
	get position() {
		return this._pos;
	}
	read(bits) {
		const byte = Math.floor(this._pos / 8);
		const bit = this._pos % 8;
		this._pos -= bits;
		return (reverse(this._data[byte - 1]) << 8) + reverse(this._data[byte]) >> 7 - bit & 255;
	}
};
/**
* @todo Old versions of Safari do not support BigInt
*/
const readInt64le = (view, offset) => {
	try {
		return view.getBigInt64(offset, true);
	} catch {
		const sign = view.getUint8(offset + 7) & 128 ? -1 : 1;
		let firstPart = view.getUint32(offset, true);
		let secondPart = view.getUint32(offset + 4, true);
		if (sign === -1) {
			firstPart = ~firstPart + 1;
			secondPart = ~secondPart + 1;
		}
		if (secondPart > 1048575) console.warn("This platform does not support BigInt");
		return sign * (firstPart + secondPart * 2 ** 32);
	}
};
//#endregion
//#region node_modules/codec-parser/src/codecs/HeaderCache.js
var HeaderCache = class {
	constructor(onCodecHeader, onCodecUpdate) {
		this._onCodecHeader = onCodecHeader;
		this._onCodecUpdate = onCodecUpdate;
		this[reset]();
	}
	[enable]() {
		this._isEnabled = true;
	}
	[reset]() {
		this._headerCache = /* @__PURE__ */ new Map();
		this._codecUpdateData = /* @__PURE__ */ new WeakMap();
		this._codecHeaderSent = false;
		this._codecShouldUpdate = false;
		this._bitrate = null;
		this._isEnabled = false;
	}
	[checkCodecUpdate](bitrate, totalDuration) {
		if (this._onCodecUpdate) {
			if (this._bitrate !== bitrate) {
				this._bitrate = bitrate;
				this._codecShouldUpdate = true;
			}
			const codecData = this._codecUpdateData.get(this._headerCache.get(this._currentHeader));
			if (this._codecShouldUpdate && codecData) this._onCodecUpdate({
				bitrate,
				...codecData
			}, totalDuration);
			this._codecShouldUpdate = false;
		}
	}
	[getHeader](key) {
		const header = this._headerCache.get(key);
		if (header) this._updateCurrentHeader(key);
		return header;
	}
	[setHeader](key, header, codecUpdateFields) {
		if (this._isEnabled) {
			if (!this._codecHeaderSent) {
				this._onCodecHeader({ ...header });
				this._codecHeaderSent = true;
			}
			this._updateCurrentHeader(key);
			this._headerCache.set(key, header);
			this._codecUpdateData.set(header, codecUpdateFields);
		}
	}
	_updateCurrentHeader(key) {
		if (this._onCodecUpdate && key !== this._currentHeader) {
			this._codecShouldUpdate = true;
			this._currentHeader = key;
		}
	}
};
//#endregion
//#region node_modules/codec-parser/src/globals.js
const headerStore = /* @__PURE__ */ new WeakMap();
const frameStore = /* @__PURE__ */ new WeakMap();
//#endregion
//#region node_modules/codec-parser/src/codecs/Parser.js
/**
* @abstract
* @description Abstract class containing methods for parsing codec frames
*/
var Parser = class {
	constructor(codecParser, headerCache) {
		this._codecParser = codecParser;
		this._headerCache = headerCache;
	}
	*[syncFrame]() {
		let frameData;
		do {
			frameData = yield* this.Frame[getFrame](this._codecParser, this._headerCache, 0);
			if (frameData) return frameData;
			this._codecParser[incrementRawData](1);
		} while (true);
	}
	/**
	* @description Searches for Frames within bytes containing a sequence of known codec frames.
	* @param {boolean} ignoreNextFrame Set to true to return frames even if the next frame may not exist at the expected location
	* @returns {Frame}
	*/
	*[fixedLengthFrameSync](ignoreNextFrame) {
		let frameData = yield* this[syncFrame]();
		const frameLength = frameStore.get(frameData)[length];
		if (ignoreNextFrame || this._codecParser._flushing || (yield* this.Header[getHeader](this._codecParser, this._headerCache, frameLength))) {
			this._headerCache[enable]();
			this._codecParser[incrementRawData](frameLength);
			this._codecParser[mapFrameStats](frameData);
			return frameData;
		}
		this._codecParser[logWarning](`Missing ${frame} at ${frameLength} bytes from current position.`, `Dropping current ${frame} and trying again.`);
		this._headerCache[reset]();
		this._codecParser[incrementRawData](1);
	}
};
//#endregion
//#region node_modules/codec-parser/src/containers/Frame.js
/**
* @abstract
*/
var Frame = class {
	constructor(headerValue, dataValue) {
		frameStore.set(this, { [header$1]: headerValue });
		this[data$1] = dataValue;
	}
};
//#endregion
//#region node_modules/codec-parser/src/codecs/CodecFrame.js
var CodecFrame = class extends Frame {
	static *[getFrame](Header, Frame, codecParser, headerCache, readOffset) {
		const headerValue = yield* Header[getHeader](codecParser, headerCache, readOffset);
		if (headerValue) {
			const frameLengthValue = headerStore.get(headerValue)[frameLength];
			const samplesValue = headerStore.get(headerValue)[samples];
			return new Frame(headerValue, (yield* codecParser[readRawData](frameLengthValue, readOffset))[subarray](0, frameLengthValue), samplesValue);
		} else return null;
	}
	constructor(headerValue, dataValue, samplesValue) {
		super(headerValue, dataValue);
		this[header$1] = headerValue;
		this[samples] = samplesValue;
		this[duration] = samplesValue / headerValue[sampleRate] * 1e3;
		this[frameNumber] = null;
		this[totalBytesOut] = null;
		this[totalSamples$1] = null;
		this[totalDuration] = null;
		frameStore.get(this)[length] = dataValue[length];
	}
};
//#endregion
//#region node_modules/codec-parser/src/metadata/ID3v2.js
const unsynchronizationFlag = "unsynchronizationFlag";
const extendedHeaderFlag = "extendedHeaderFlag";
const experimentalFlag = "experimentalFlag";
const footerPresent = "footerPresent";
var ID3v2 = class ID3v2 {
	static *getID3v2Header(codecParser, headerCache, readOffset) {
		const headerLength = 10;
		const header = {};
		let data = yield* codecParser[readRawData](3, readOffset);
		if (data[0] !== 73 || data[1] !== 68 || data[2] !== 51) return null;
		data = yield* codecParser[readRawData](headerLength, readOffset);
		header[version] = `id3v2.${data[3]}.${data[4]}`;
		if (data[5] & 15) return null;
		header[unsynchronizationFlag] = !!(data[5] & 128);
		header[extendedHeaderFlag] = !!(data[5] & 64);
		header[experimentalFlag] = !!(data[5] & 32);
		header[footerPresent] = !!(data[5] & 16);
		if (data[6] & 128 || data[7] & 128 || data[8] & 128 || data[9] & 128) return null;
		header[length] = headerLength + (data[6] << 21 | data[7] << 14 | data[8] << 7 | data[9]);
		return new ID3v2(header);
	}
	constructor(header) {
		this[version] = header[version];
		this[unsynchronizationFlag] = header[unsynchronizationFlag];
		this[extendedHeaderFlag] = header[extendedHeaderFlag];
		this[experimentalFlag] = header[experimentalFlag];
		this[footerPresent] = header[footerPresent];
		this[length] = header[length];
	}
};
//#endregion
//#region node_modules/codec-parser/src/codecs/CodecHeader.js
var CodecHeader = class {
	/**
	* @private
	*/
	constructor(header) {
		headerStore.set(this, header);
		this[bitDepth] = header[bitDepth];
		this[bitrate] = null;
		this[channels$1] = header[channels$1];
		this[channelMode] = header[channelMode];
		this[sampleRate] = header[sampleRate];
	}
};
//#endregion
//#region node_modules/codec-parser/src/codecs/mpeg/MPEGHeader.js
const bitrateMatrix = {
	0: [
		free,
		free,
		free,
		free,
		free
	],
	16: [
		32,
		32,
		32,
		32,
		8
	],
	240: [
		"bad",
		"bad",
		"bad",
		"bad",
		"bad"
	]
};
const calcBitrate = (idx, interval, intervalOffset) => 8 * ((idx + intervalOffset) % interval + interval) * (1 << (idx + intervalOffset) / interval) - 8 * interval * (interval / 8 | 0);
for (let i = 2; i < 15; i++) bitrateMatrix[i << 4] = [
	i * 32,
	calcBitrate(i, 4, 0),
	calcBitrate(i, 4, -1),
	calcBitrate(i, 8, 4),
	calcBitrate(i, 8, 0)
];
const v1Layer1 = 0;
const v1Layer2 = 1;
const v1Layer3 = 2;
const v2Layer1 = 3;
const v2Layer23 = 4;
const bands = "bands ";
const to31 = " to 31";
const layer12ModeExtensions = {
	0: bands + 4 + to31,
	16: bands + 8 + to31,
	32: bands + 12 + to31,
	48: bands + 16 + to31
};
const bitrateIndex = "bitrateIndex";
const v2 = "v2";
const v1 = "v1";
const intensityStereo = "Intensity stereo ";
const msStereo = ", MS stereo ";
const on = "on";
const off = "off";
const layer3ModeExtensions = {
	0: intensityStereo + off + msStereo + off,
	16: intensityStereo + on + msStereo + off,
	32: intensityStereo + off + msStereo + on,
	48: intensityStereo + on + msStereo + on
};
const layersValues = {
	0: { [description]: reserved },
	2: {
		[description]: "Layer III",
		[framePadding]: 1,
		[modeExtension]: layer3ModeExtensions,
		[v1]: {
			[bitrateIndex]: v1Layer3,
			[samples]: 1152
		},
		[v2]: {
			[bitrateIndex]: v2Layer23,
			[samples]: 576
		}
	},
	4: {
		[description]: "Layer II",
		[framePadding]: 1,
		[modeExtension]: layer12ModeExtensions,
		[samples]: 1152,
		[v1]: { [bitrateIndex]: v1Layer2 },
		[v2]: { [bitrateIndex]: v2Layer23 }
	},
	6: {
		[description]: "Layer I",
		[framePadding]: 4,
		[modeExtension]: layer12ModeExtensions,
		[samples]: 384,
		[v1]: { [bitrateIndex]: v1Layer1 },
		[v2]: { [bitrateIndex]: v2Layer1 }
	}
};
const mpegVersionDescription = "MPEG Version ";
const isoIec = "ISO/IEC ";
const mpegVersions = {
	0: {
		[description]: `${mpegVersionDescription}2.5 (later extension of MPEG 2)`,
		[layer]: v2,
		[sampleRate]: {
			0: rate11025,
			4: rate12000,
			8: rate8000,
			12: reserved
		}
	},
	8: { [description]: reserved },
	16: {
		[description]: `${mpegVersionDescription}2 (${isoIec}13818-3)`,
		[layer]: v2,
		[sampleRate]: {
			0: rate22050,
			4: rate24000,
			8: rate16000,
			12: reserved
		}
	},
	24: {
		[description]: `${mpegVersionDescription}1 (${isoIec}11172-3)`,
		[layer]: v1,
		[sampleRate]: {
			0: rate44100,
			4: rate48000,
			8: rate32000,
			12: reserved
		}
	},
	length
};
const protectionValues$1 = {
	0: sixteenBitCRC,
	1: none
};
const emphasisValues = {
	0: none,
	1: "50/15 ms",
	2: reserved,
	3: "CCIT J.17"
};
const channelModes = {
	0: {
		[channels$1]: 2,
		[description]: stereo
	},
	64: {
		[channels$1]: 2,
		[description]: "joint " + stereo
	},
	128: {
		[channels$1]: 2,
		[description]: "dual channel"
	},
	192: {
		[channels$1]: 1,
		[description]: monophonic
	}
};
var MPEGHeader = class MPEGHeader extends CodecHeader {
	static *[getHeader](codecParser, headerCache, readOffset) {
		const header = {};
		const id3v2Header = yield* ID3v2.getID3v2Header(codecParser, headerCache, readOffset);
		if (id3v2Header) {
			yield* codecParser[readRawData](id3v2Header[length], readOffset);
			codecParser[incrementRawData](id3v2Header[length]);
		}
		const data = yield* codecParser[readRawData](4, readOffset);
		const key = bytesToString(data[subarray](0, 4));
		const cachedHeader = headerCache[getHeader](key);
		if (cachedHeader) return new MPEGHeader(cachedHeader);
		if (data[0] !== 255 || data[1] < 224) return null;
		const mpegVersionValues = mpegVersions[data[1] & 24];
		if (mpegVersionValues["description"] === "reserved") return null;
		const layerBits = data[1] & 6;
		if (layersValues[layerBits]["description"] === "reserved") return null;
		const layerValues = {
			...layersValues[layerBits],
			...layersValues[layerBits][mpegVersionValues[layer]]
		};
		header[mpegVersion] = mpegVersionValues[description];
		header[layer] = layerValues[description];
		header[samples] = layerValues[samples];
		header[protection] = protectionValues$1[data[1] & 1];
		header[length] = 4;
		header[bitrate] = bitrateMatrix[data[2] & 240][layerValues[bitrateIndex]];
		if (header["bitrate"] === "bad") return null;
		header[sampleRate] = mpegVersionValues[sampleRate][data[2] & 12];
		if (header[sampleRate] === "reserved") return null;
		header[framePadding] = data[2] & 2 && layerValues["framePadding"];
		header[isPrivate] = !!(data[2] & 1);
		header[frameLength] = Math.floor(125 * header[bitrate] * header[samples] / header[sampleRate] + header[framePadding]);
		if (!header["frameLength"]) return null;
		const channelModeBits = data[3] & 192;
		header[channelMode] = channelModes[channelModeBits][description];
		header[channels$1] = channelModes[channelModeBits][channels$1];
		header[modeExtension] = layerValues[modeExtension][data[3] & 48];
		header[isCopyrighted] = !!(data[3] & 8);
		header[isOriginal] = !!(data[3] & 4);
		header[emphasis] = emphasisValues[data[3] & 3];
		if (header["emphasis"] === "reserved") return null;
		header[bitDepth] = 16;
		{
			const { length, frameLength, samples, ...codecUpdateFields } = header;
			headerCache[setHeader](key, header, codecUpdateFields);
		}
		return new MPEGHeader(header);
	}
	/**
	* @private
	* Call MPEGHeader.getHeader(Array<Uint8>) to get instance
	*/
	constructor(header) {
		super(header);
		this[bitrate] = header[bitrate];
		this[emphasis] = header[emphasis];
		this[framePadding] = header[framePadding];
		this[isCopyrighted] = header[isCopyrighted];
		this[isOriginal] = header[isOriginal];
		this[isPrivate] = header[isPrivate];
		this[layer] = header[layer];
		this[modeExtension] = header[modeExtension];
		this[mpegVersion] = header[mpegVersion];
		this[protection] = header[protection];
	}
};
//#endregion
//#region node_modules/codec-parser/src/codecs/mpeg/MPEGFrame.js
var MPEGFrame = class MPEGFrame extends CodecFrame {
	static *[getFrame](codecParser, headerCache, readOffset) {
		return yield* super[getFrame](MPEGHeader, MPEGFrame, codecParser, headerCache, readOffset);
	}
	constructor(header, frame, samples) {
		super(header, frame, samples);
	}
};
//#endregion
//#region node_modules/codec-parser/src/codecs/mpeg/MPEGParser.js
var MPEGParser = class extends Parser {
	constructor(codecParser, headerCache, onCodec) {
		super(codecParser, headerCache);
		this.Frame = MPEGFrame;
		this.Header = MPEGHeader;
		onCodec(this[codec]);
	}
	get [codec]() {
		return mpeg;
	}
	*[parseFrame]() {
		return yield* this[fixedLengthFrameSync]();
	}
};
//#endregion
//#region node_modules/codec-parser/src/codecs/aac/AACHeader.js
const mpegVersionValues = {
	0: "MPEG-4",
	8: "MPEG-2"
};
const layerValues = {
	0: "valid",
	2: "bad",
	4: "bad",
	6: "bad"
};
const protectionValues = {
	0: sixteenBitCRC,
	1: none
};
const profileValues = {
	0: "AAC Main",
	64: "AAC LC (Low Complexity)",
	128: "AAC SSR (Scalable Sample Rate)",
	192: "AAC LTP (Long Term Prediction)"
};
const sampleRates = {
	0: rate96000,
	4: rate88200,
	8: rate64000,
	12: rate48000,
	16: rate44100,
	20: rate32000,
	24: rate24000,
	28: rate22050,
	32: rate16000,
	36: rate12000,
	40: rate11025,
	44: rate8000,
	48: rate7350,
	52: reserved,
	56: reserved,
	60: "frequency is written explicitly"
};
const channelModeValues = {
	0: {
		[channels$1]: 0,
		[description]: "Defined in AOT Specific Config"
	},
	64: {
		[channels$1]: 1,
		[description]: monophonic
	},
	128: {
		[channels$1]: 2,
		[description]: getChannelMapping(2, channelMappings[0][0])
	},
	192: {
		[channels$1]: 3,
		[description]: getChannelMapping(3, channelMappings[1][3])
	},
	256: {
		[channels$1]: 4,
		[description]: getChannelMapping(4, channelMappings[1][3], channelMappings[3][4])
	},
	320: {
		[channels$1]: 5,
		[description]: getChannelMapping(5, channelMappings[1][3], channelMappings[3][0])
	},
	384: {
		[channels$1]: 6,
		[description]: getChannelMapping(6, channelMappings[1][3], channelMappings[3][0], "LFE")
	},
	448: {
		[channels$1]: 8,
		[description]: getChannelMapping(8, channelMappings[1][3], channelMappings[2][0], channelMappings[3][0], "LFE")
	}
};
var AACHeader = class AACHeader extends CodecHeader {
	static *[getHeader](codecParser, headerCache, readOffset) {
		const header = {};
		const data = yield* codecParser[readRawData](7, readOffset);
		const key = bytesToString([
			data[0],
			data[1],
			data[2],
			data[3] & 252 | data[6] & 3
		]);
		const cachedHeader = headerCache[getHeader](key);
		if (!cachedHeader) {
			if (data[0] !== 255 || data[1] < 240) return null;
			header[mpegVersion] = mpegVersionValues[data[1] & 8];
			header[layer] = layerValues[data[1] & 6];
			if (header["layer"] === "bad") return null;
			const protectionBit = data[1] & 1;
			header[protection] = protectionValues[protectionBit];
			header[length] = protectionBit ? 7 : 9;
			header[profileBits] = data[2] & 192;
			header[sampleRateBits] = data[2] & 60;
			const privateBit = data[2] & 2;
			header[profile] = profileValues[header[profileBits]];
			header[sampleRate] = sampleRates[header[sampleRateBits]];
			if (header[sampleRate] === "reserved") return null;
			header[isPrivate] = !!privateBit;
			header[channelModeBits] = (data[2] << 8 | data[3]) & 448;
			header[channelMode] = channelModeValues[header[channelModeBits]][description];
			header[channels$1] = channelModeValues[header[channelModeBits]][channels$1];
			header[isOriginal] = !!(data[3] & 32);
			header[isHome] = !!(data[3] & 8);
			header[copyrightId] = !!(data[3] & 8);
			header[copyrightIdStart] = !!(data[3] & 4);
			header[bitDepth] = 16;
			header[samples] = 1024;
			header[numberAACFrames] = data[6] & 3;
			{
				const { length, channelModeBits, profileBits, sampleRateBits, frameLength, samples, numberAACFrames, ...codecUpdateFields } = header;
				headerCache[setHeader](key, header, codecUpdateFields);
			}
		} else Object.assign(header, cachedHeader);
		header[frameLength] = (data[3] << 11 | data[4] << 3 | data[5] >> 5) & 8191;
		if (!header["frameLength"]) return null;
		const bufferFullnessBits = (data[5] << 6 | data[6] >> 2) & 2047;
		header[bufferFullness] = bufferFullnessBits === 2047 ? "VBR" : bufferFullnessBits;
		return new AACHeader(header);
	}
	/**
	* @private
	* Call AACHeader.getHeader(Array<Uint8>) to get instance
	*/
	constructor(header) {
		super(header);
		this[copyrightId] = header[copyrightId];
		this[copyrightIdStart] = header[copyrightIdStart];
		this[bufferFullness] = header[bufferFullness];
		this[isHome] = header[isHome];
		this[isOriginal] = header[isOriginal];
		this[isPrivate] = header[isPrivate];
		this[layer] = header[layer];
		this[length] = header[length];
		this[mpegVersion] = header[mpegVersion];
		this[numberAACFrames] = header[numberAACFrames];
		this[profile] = header[profile];
		this[protection] = header[protection];
	}
	get audioSpecificConfig() {
		const header = headerStore.get(this);
		const audioSpecificConfig = header[profileBits] + 64 << 5 | header[sampleRateBits] << 5 | header[channelModeBits] >> 3;
		const bytes = new uint8Array(2);
		new dataView(bytes[buffer]).setUint16(0, audioSpecificConfig, false);
		return bytes;
	}
};
//#endregion
//#region node_modules/codec-parser/src/codecs/aac/AACFrame.js
var AACFrame = class AACFrame extends CodecFrame {
	static *[getFrame](codecParser, headerCache, readOffset) {
		return yield* super[getFrame](AACHeader, AACFrame, codecParser, headerCache, readOffset);
	}
	constructor(header, frame, samples) {
		super(header, frame, samples);
	}
};
//#endregion
//#region node_modules/codec-parser/src/codecs/aac/AACParser.js
var AACParser = class extends Parser {
	constructor(codecParser, headerCache, onCodec) {
		super(codecParser, headerCache);
		this.Frame = AACFrame;
		this.Header = AACHeader;
		onCodec(this[codec]);
	}
	get [codec]() {
		return "aac";
	}
	*[parseFrame]() {
		return yield* this[fixedLengthFrameSync]();
	}
};
//#endregion
//#region node_modules/codec-parser/src/codecs/flac/FLACFrame.js
var FLACFrame = class FLACFrame extends CodecFrame {
	static _getFrameFooterCrc16(data) {
		return (data[data[length] - 2] << 8) + data[data[length] - 1];
	}
	static [checkFrameFooterCrc16](data) {
		return FLACFrame._getFrameFooterCrc16(data) === flacCrc16(data[subarray](0, -2));
	}
	constructor(data, header, streamInfoValue) {
		header[streamInfo] = streamInfoValue;
		header[crc16] = FLACFrame._getFrameFooterCrc16(data);
		super(header, data, headerStore.get(header)[samples]);
	}
};
//#endregion
//#region node_modules/codec-parser/src/codecs/flac/FLACHeader.js
const getFromStreamInfo = "get from STREAMINFO metadata block";
const blockingStrategyValues = {
	0: "Fixed",
	1: "Variable"
};
const blockSizeValues = {
	0: reserved,
	16: 192
};
for (let i = 2; i < 16; i++) blockSizeValues[i << 4] = i < 6 ? 576 * 2 ** (i - 2) : 2 ** i;
const sampleRateValues = {
	0: getFromStreamInfo,
	1: rate88200,
	2: rate176400,
	3: rate192000,
	4: rate8000,
	5: rate16000,
	6: rate22050,
	7: rate24000,
	8: rate32000,
	9: rate44100,
	10: rate48000,
	11: rate96000,
	15: "bad"
};
const channelAssignments = {
	0: {
		[channels$1]: 1,
		[description]: monophonic
	},
	16: {
		[channels$1]: 2,
		[description]: getChannelMapping(2, channelMappings[0][0])
	},
	32: {
		[channels$1]: 3,
		[description]: getChannelMapping(3, channelMappings[0][1])
	},
	48: {
		[channels$1]: 4,
		[description]: getChannelMapping(4, channelMappings[1][0], channelMappings[3][0])
	},
	64: {
		[channels$1]: 5,
		[description]: getChannelMapping(5, channelMappings[1][1], channelMappings[3][0])
	},
	80: {
		[channels$1]: 6,
		[description]: getChannelMapping(6, channelMappings[1][1], "LFE", channelMappings[3][0])
	},
	96: {
		[channels$1]: 7,
		[description]: getChannelMapping(7, channelMappings[1][1], "LFE", channelMappings[3][4], channelMappings[2][0])
	},
	112: {
		[channels$1]: 8,
		[description]: getChannelMapping(8, channelMappings[1][1], "LFE", channelMappings[3][0], channelMappings[2][0])
	},
	128: {
		[channels$1]: 2,
		[description]: `${stereo} (left, diff)`
	},
	144: {
		[channels$1]: 2,
		[description]: `${stereo} (diff, right)`
	},
	160: {
		[channels$1]: 2,
		[description]: `${stereo} (avg, diff)`
	},
	176: reserved,
	192: reserved,
	208: reserved,
	224: reserved,
	240: reserved
};
const bitDepthValues = {
	0: getFromStreamInfo,
	2: 8,
	4: 12,
	6: reserved,
	8: 16,
	10: 20,
	12: 24,
	14: reserved
};
var FLACHeader = class FLACHeader extends CodecHeader {
	static _decodeUTF8Int(data) {
		if (data[0] > 254) return null;
		if (data[0] < 128) return {
			value: data[0],
			length: 1
		};
		let length = 1;
		for (let zeroMask = 64; zeroMask & data[0]; zeroMask >>= 1) length++;
		let idx = length - 1, value = 0, shift = 0;
		for (; idx > 0; shift += 6, idx--) {
			if ((data[idx] & 192) !== 128) return null;
			value |= (data[idx] & 63) << shift;
		}
		value |= (data[idx] & 127 >> length) << shift;
		return {
			value,
			length
		};
	}
	static [getHeaderFromUint8Array](data, headerCache) {
		const codecParserStub = { [readRawData]: function* () {
			return data;
		} };
		return FLACHeader[getHeader](codecParserStub, headerCache, 0).next().value;
	}
	static *[getHeader](codecParser, headerCache, readOffset) {
		let data = yield* codecParser[readRawData](6, readOffset);
		if (data[0] !== 255 || !(data[1] === 248 || data[1] === 249)) return null;
		const header = {};
		const key = bytesToString(data[subarray](0, 4));
		const cachedHeader = headerCache[getHeader](key);
		if (!cachedHeader) {
			header[blockingStrategyBits] = data[1] & 1;
			header[blockingStrategy] = blockingStrategyValues[header[blockingStrategyBits]];
			header[blockSizeBits] = data[2] & 240;
			header[sampleRateBits] = data[2] & 15;
			header[blockSize] = blockSizeValues[header[blockSizeBits]];
			if (header["blockSize"] === "reserved") return null;
			header[sampleRate] = sampleRateValues[header[sampleRateBits]];
			if (header[sampleRate] === "bad") return null;
			if (data[3] & 1) return null;
			const channelAssignment = channelAssignments[data[3] & 240];
			if (channelAssignment === "reserved") return null;
			header[channels$1] = channelAssignment[channels$1];
			header[channelMode] = channelAssignment[description];
			header[bitDepth] = bitDepthValues[data[3] & 14];
			if (header["bitDepth"] === "reserved") return null;
		} else Object.assign(header, cachedHeader);
		header[length] = 5;
		data = yield* codecParser[readRawData](header[length] + 8, readOffset);
		const decodedUtf8 = FLACHeader._decodeUTF8Int(data[subarray](4));
		if (!decodedUtf8) return null;
		if (header[blockingStrategyBits]) header[sampleNumber] = decodedUtf8.value;
		else header[frameNumber] = decodedUtf8.value;
		header[length] += decodedUtf8[length];
		if (header[blockSizeBits] === 96) {
			if (data["length"] < header["length"]) data = yield* codecParser[readRawData](header[length], readOffset);
			header[blockSize] = data[header[length] - 1] + 1;
			header[length] += 1;
		} else if (header[blockSizeBits] === 112) {
			if (data["length"] < header["length"]) data = yield* codecParser[readRawData](header[length], readOffset);
			header[blockSize] = (data[header[length] - 1] << 8) + data[header[length]] + 1;
			header[length] += 2;
		}
		header[samples] = header[blockSize];
		if (header[sampleRateBits] === 12) {
			if (data["length"] < header["length"]) data = yield* codecParser[readRawData](header[length], readOffset);
			header[sampleRate] = data[header[length] - 1] * 1e3;
			header[length] += 1;
		} else if (header[sampleRateBits] === 13) {
			if (data["length"] < header["length"]) data = yield* codecParser[readRawData](header[length], readOffset);
			header[sampleRate] = (data[header[length] - 1] << 8) + data[header[length]];
			header[length] += 2;
		} else if (header[sampleRateBits] === 14) {
			if (data["length"] < header["length"]) data = yield* codecParser[readRawData](header[length], readOffset);
			header[sampleRate] = ((data[header[length] - 1] << 8) + data[header[length]]) * 10;
			header[length] += 2;
		}
		if (data["length"] < header["length"]) data = yield* codecParser[readRawData](header[length], readOffset);
		header["crc"] = data[header[length] - 1];
		if (header["crc"] !== crc8(data["subarray"](0, header["length"] - 1))) return null;
		if (!cachedHeader) {
			const { blockingStrategyBits, frameNumber, sampleNumber, samples, sampleRateBits, blockSizeBits, crc, length, ...codecUpdateFields } = header;
			headerCache[setHeader](key, header, codecUpdateFields);
		}
		return new FLACHeader(header);
	}
	/**
	* @private
	* Call FLACHeader.getHeader(Array<Uint8>) to get instance
	*/
	constructor(header) {
		super(header);
		this[crc16] = null;
		this[blockingStrategy] = header[blockingStrategy];
		this[blockSize] = header[blockSize];
		this[frameNumber] = header[frameNumber];
		this[sampleNumber] = header[sampleNumber];
		this[streamInfo] = null;
	}
};
//#endregion
//#region node_modules/codec-parser/src/codecs/flac/FLACParser.js
const MIN_FLAC_FRAME_SIZE = 2;
const MAX_FLAC_FRAME_SIZE = 512 * 1024;
var FLACParser = class extends Parser {
	constructor(codecParser, headerCache, onCodec) {
		super(codecParser, headerCache);
		this.Frame = FLACFrame;
		this.Header = FLACHeader;
		onCodec(this[codec]);
	}
	get [codec]() {
		return "flac";
	}
	*_getNextFrameSyncOffset(offset) {
		const data = yield* this._codecParser[readRawData](2, 0);
		const dataLength = data[length] - 2;
		while (offset < dataLength) {
			if (data[offset] === 255) {
				const secondByte = data[offset + 1];
				if (secondByte === 248 || secondByte === 249) break;
				if (secondByte !== 255) offset++;
			}
			offset++;
		}
		return offset;
	}
	*[parseFrame]() {
		do {
			const header = yield* FLACHeader[getHeader](this._codecParser, this._headerCache, 0);
			if (header) {
				let nextHeaderOffset = headerStore.get(header)[length] + MIN_FLAC_FRAME_SIZE;
				while (nextHeaderOffset <= MAX_FLAC_FRAME_SIZE) {
					if (this._codecParser._flushing || (yield* FLACHeader[getHeader](this._codecParser, this._headerCache, nextHeaderOffset))) {
						let frameData = yield* this._codecParser[readRawData](nextHeaderOffset);
						if (!this._codecParser._flushing) frameData = frameData[subarray](0, nextHeaderOffset);
						if (FLACFrame[checkFrameFooterCrc16](frameData)) {
							const frame = new FLACFrame(frameData, header);
							this._headerCache[enable]();
							this._codecParser[incrementRawData](nextHeaderOffset);
							this._codecParser[mapFrameStats](frame);
							return frame;
						}
					}
					nextHeaderOffset = yield* this._getNextFrameSyncOffset(nextHeaderOffset + 1);
				}
				this._codecParser[logWarning](`Unable to sync FLAC frame after searching ${nextHeaderOffset} bytes.`);
				this._codecParser[incrementRawData](nextHeaderOffset);
			} else this._codecParser[incrementRawData](yield* this._getNextFrameSyncOffset(1));
		} while (true);
	}
	[parseOggPage](oggPage) {
		if (oggPage["pageSequenceNumber"] === 0) {
			this._headerCache[enable]();
			this._streamInfo = oggPage[data$1][subarray](13);
		} else if (oggPage["pageSequenceNumber"] === 1) {} else oggPage[codecFrames$1] = frameStore.get(oggPage)[segments].map((segment) => {
			const header = FLACHeader[getHeaderFromUint8Array](segment, this._headerCache);
			if (header) return new FLACFrame(segment, header, this._streamInfo);
			else this._codecParser[logWarning]("Failed to parse Ogg FLAC frame", "Skipping invalid FLAC frame");
		}).filter((frame) => !!frame);
		return oggPage;
	}
};
//#endregion
//#region node_modules/codec-parser/src/containers/ogg/OggPageHeader.js
var OggPageHeader = class OggPageHeader {
	static *[getHeader](codecParser, headerCache, readOffset) {
		const header = {};
		let data = yield* codecParser[readRawData](28, readOffset);
		if (data[0] !== 79 || data[1] !== 103 || data[2] !== 103 || data[3] !== 83) return null;
		header[streamStructureVersion] = data[4];
		if (data[5] & 248) return null;
		header[isLastPage$1] = !!(data[5] & 4);
		header[isFirstPage] = !!(data[5] & 2);
		header[isContinuedPacket] = !!(data[5] & 1);
		const view = new dataView(uint8Array.from(data[subarray](0, 28))[buffer]);
		header[absoluteGranulePosition$1] = readInt64le(view, 6);
		header[streamSerialNumber] = view.getInt32(14, true);
		header[pageSequenceNumber] = view.getInt32(18, true);
		header[pageChecksum] = view.getInt32(22, true);
		const pageSegmentTableLength = data[26];
		header[length] = pageSegmentTableLength + 27;
		data = yield* codecParser[readRawData](header[length], readOffset);
		header[frameLength] = 0;
		header[pageSegmentTable] = [];
		header[pageSegmentBytes] = uint8Array.from(data[subarray](27, header[length]));
		for (let i = 0, segmentLength = 0; i < pageSegmentTableLength; i++) {
			const segmentByte = header[pageSegmentBytes][i];
			header[frameLength] += segmentByte;
			segmentLength += segmentByte;
			if (segmentByte !== 255 || i === pageSegmentTableLength - 1) {
				header[pageSegmentTable].push(segmentLength);
				segmentLength = 0;
			}
		}
		return new OggPageHeader(header);
	}
	/**
	* @private
	* Call OggPageHeader.getHeader(Array<Uint8>) to get instance
	*/
	constructor(header) {
		headerStore.set(this, header);
		this[absoluteGranulePosition$1] = header[absoluteGranulePosition$1];
		this[isContinuedPacket] = header[isContinuedPacket];
		this[isFirstPage] = header[isFirstPage];
		this[isLastPage$1] = header[isLastPage$1];
		this[pageSegmentTable] = header[pageSegmentTable];
		this[pageSequenceNumber] = header[pageSequenceNumber];
		this[pageChecksum] = header[pageChecksum];
		this[streamSerialNumber] = header[streamSerialNumber];
	}
};
//#endregion
//#region node_modules/codec-parser/src/containers/ogg/OggPage.js
var OggPage = class OggPage extends Frame {
	static *[getFrame](codecParser, headerCache, readOffset) {
		const header = yield* OggPageHeader[getHeader](codecParser, headerCache, readOffset);
		if (header) {
			const frameLengthValue = headerStore.get(header)[frameLength];
			const headerLength = headerStore.get(header)[length];
			const totalLength = headerLength + frameLengthValue;
			const rawDataValue = (yield* codecParser[readRawData](totalLength, 0))[subarray](0, totalLength);
			return new OggPage(header, rawDataValue[subarray](headerLength, totalLength), rawDataValue);
		} else return null;
	}
	constructor(header, frame, rawDataValue) {
		super(header, frame);
		frameStore.get(this)[length] = rawDataValue[length];
		this[codecFrames$1] = [];
		this[rawData] = rawDataValue;
		this[absoluteGranulePosition$1] = header[absoluteGranulePosition$1];
		this[crc32] = header[pageChecksum];
		this[duration] = 0;
		this[isContinuedPacket] = header[isContinuedPacket];
		this[isFirstPage] = header[isFirstPage];
		this[isLastPage$1] = header[isLastPage$1];
		this[pageSequenceNumber] = header[pageSequenceNumber];
		this[samples] = 0;
		this[streamSerialNumber] = header[streamSerialNumber];
	}
};
//#endregion
//#region node_modules/codec-parser/src/codecs/opus/OpusFrame.js
var OpusFrame = class extends CodecFrame {
	constructor(data, header, samples) {
		super(header, data, samples);
	}
};
//#endregion
//#region node_modules/codec-parser/src/codecs/opus/OpusHeader.js
const channelMappingFamilies = {
	0: vorbisOpusChannelMapping.slice(0, 2),
	1: vorbisOpusChannelMapping
};
const silkOnly = "SILK-only";
const celtOnly = "CELT-only";
const hybrid = "Hybrid";
const narrowBand = "narrowband";
const mediumBand = "medium-band";
const wideBand = "wideband";
const superWideBand = "super-wideband";
const fullBand = "fullband";
const configTable = {
	0: {
		[mode]: silkOnly,
		[bandwidth]: narrowBand,
		[frameSize]: 10
	},
	8: {
		[mode]: silkOnly,
		[bandwidth]: narrowBand,
		[frameSize]: 20
	},
	16: {
		[mode]: silkOnly,
		[bandwidth]: narrowBand,
		[frameSize]: 40
	},
	24: {
		[mode]: silkOnly,
		[bandwidth]: narrowBand,
		[frameSize]: 60
	},
	32: {
		[mode]: silkOnly,
		[bandwidth]: mediumBand,
		[frameSize]: 10
	},
	40: {
		[mode]: silkOnly,
		[bandwidth]: mediumBand,
		[frameSize]: 20
	},
	48: {
		[mode]: silkOnly,
		[bandwidth]: mediumBand,
		[frameSize]: 40
	},
	56: {
		[mode]: silkOnly,
		[bandwidth]: mediumBand,
		[frameSize]: 60
	},
	64: {
		[mode]: silkOnly,
		[bandwidth]: wideBand,
		[frameSize]: 10
	},
	72: {
		[mode]: silkOnly,
		[bandwidth]: wideBand,
		[frameSize]: 20
	},
	80: {
		[mode]: silkOnly,
		[bandwidth]: wideBand,
		[frameSize]: 40
	},
	88: {
		[mode]: silkOnly,
		[bandwidth]: wideBand,
		[frameSize]: 60
	},
	96: {
		[mode]: hybrid,
		[bandwidth]: superWideBand,
		[frameSize]: 10
	},
	104: {
		[mode]: hybrid,
		[bandwidth]: superWideBand,
		[frameSize]: 20
	},
	112: {
		[mode]: hybrid,
		[bandwidth]: fullBand,
		[frameSize]: 10
	},
	120: {
		[mode]: hybrid,
		[bandwidth]: fullBand,
		[frameSize]: 20
	},
	128: {
		[mode]: celtOnly,
		[bandwidth]: narrowBand,
		[frameSize]: 2.5
	},
	136: {
		[mode]: celtOnly,
		[bandwidth]: narrowBand,
		[frameSize]: 5
	},
	144: {
		[mode]: celtOnly,
		[bandwidth]: narrowBand,
		[frameSize]: 10
	},
	152: {
		[mode]: celtOnly,
		[bandwidth]: narrowBand,
		[frameSize]: 20
	},
	160: {
		[mode]: celtOnly,
		[bandwidth]: wideBand,
		[frameSize]: 2.5
	},
	168: {
		[mode]: celtOnly,
		[bandwidth]: wideBand,
		[frameSize]: 5
	},
	176: {
		[mode]: celtOnly,
		[bandwidth]: wideBand,
		[frameSize]: 10
	},
	184: {
		[mode]: celtOnly,
		[bandwidth]: wideBand,
		[frameSize]: 20
	},
	192: {
		[mode]: celtOnly,
		[bandwidth]: superWideBand,
		[frameSize]: 2.5
	},
	200: {
		[mode]: celtOnly,
		[bandwidth]: superWideBand,
		[frameSize]: 5
	},
	208: {
		[mode]: celtOnly,
		[bandwidth]: superWideBand,
		[frameSize]: 10
	},
	216: {
		[mode]: celtOnly,
		[bandwidth]: superWideBand,
		[frameSize]: 20
	},
	224: {
		[mode]: celtOnly,
		[bandwidth]: fullBand,
		[frameSize]: 2.5
	},
	232: {
		[mode]: celtOnly,
		[bandwidth]: fullBand,
		[frameSize]: 5
	},
	240: {
		[mode]: celtOnly,
		[bandwidth]: fullBand,
		[frameSize]: 10
	},
	248: {
		[mode]: celtOnly,
		[bandwidth]: fullBand,
		[frameSize]: 20
	}
};
var OpusHeader = class OpusHeader extends CodecHeader {
	static [getHeaderFromUint8Array](dataValue, packetData, headerCache) {
		const header = {};
		header[channels$1] = dataValue[9];
		header[channelMappingFamily] = dataValue[18];
		header[length] = header["channelMappingFamily"] !== 0 ? 21 + header[channels$1] : 19;
		if (dataValue["length"] < header["length"]) throw new Error("Out of data while inside an Ogg Page");
		const packetMode = packetData[0] & 3;
		const packetLength = packetMode === 3 ? 2 : 1;
		const key = bytesToString(dataValue[subarray](0, header[length])) + bytesToString(packetData[subarray](0, packetLength));
		const cachedHeader = headerCache[getHeader](key);
		if (cachedHeader) return new OpusHeader(cachedHeader);
		if (key.substr(0, 8) !== "OpusHead") return null;
		if (dataValue[8] !== 1) return null;
		header[data$1] = uint8Array.from(dataValue[subarray](0, header[length]));
		const view = new dataView(header[data$1][buffer]);
		header[bitDepth] = 16;
		header[preSkip$1] = view.getUint16(10, true);
		header[inputSampleRate] = view.getUint32(12, true);
		header[sampleRate] = rate48000;
		header[outputGain] = view.getInt16(16, true);
		if (header["channelMappingFamily"] in channelMappingFamilies) {
			header[channelMode] = channelMappingFamilies[header[channelMappingFamily]][header[channels$1] - 1];
			if (!header["channelMode"]) return null;
		}
		if (header["channelMappingFamily"] !== 0) {
			header[streamCount$1] = dataValue[19];
			header[coupledStreamCount$1] = dataValue[20];
			header[channelMappingTable$1] = [...dataValue[subarray](21, header[channels$1] + 21)];
		}
		const packetConfig = configTable[248 & packetData[0]];
		header[mode] = packetConfig[mode];
		header[bandwidth] = packetConfig[bandwidth];
		header[frameSize] = packetConfig[frameSize];
		switch (packetMode) {
			case 0:
				header[frameCount] = 1;
				break;
			case 1:
			case 2:
				header[frameCount] = 2;
				break;
			case 3:
				header[isVbr] = !!(128 & packetData[1]);
				header[hasOpusPadding] = !!(64 & packetData[1]);
				header[frameCount] = 63 & packetData[1];
				break;
			default: return null;
		}
		{
			const { length, data: headerData, channelMappingFamily, ...codecUpdateFields } = header;
			headerCache[setHeader](key, header, codecUpdateFields);
		}
		return new OpusHeader(header);
	}
	/**
	* @private
	* Call OpusHeader.getHeader(Array<Uint8>) to get instance
	*/
	constructor(header) {
		super(header);
		this[data$1] = header[data$1];
		this[bandwidth] = header[bandwidth];
		this[channelMappingFamily] = header[channelMappingFamily];
		this[channelMappingTable$1] = header[channelMappingTable$1];
		this[coupledStreamCount$1] = header[coupledStreamCount$1];
		this[frameCount] = header[frameCount];
		this[frameSize] = header[frameSize];
		this[hasOpusPadding] = header[hasOpusPadding];
		this[inputSampleRate] = header[inputSampleRate];
		this[isVbr] = header[isVbr];
		this[mode] = header[mode];
		this[outputGain] = header[outputGain];
		this[preSkip$1] = header[preSkip$1];
		this[streamCount$1] = header[streamCount$1];
	}
};
//#endregion
//#region node_modules/codec-parser/src/codecs/opus/OpusParser.js
var OpusParser = class extends Parser {
	constructor(codecParser, headerCache, onCodec) {
		super(codecParser, headerCache);
		this.Frame = OpusFrame;
		this.Header = OpusHeader;
		onCodec(this[codec]);
		this._identificationHeader = null;
		this._preSkipRemaining = null;
	}
	get [codec]() {
		return "opus";
	}
	/**
	* @todo implement continued page support
	*/
	[parseOggPage](oggPage) {
		if (oggPage["pageSequenceNumber"] === 0) {
			this._headerCache[enable]();
			this._identificationHeader = oggPage[data$1];
		} else if (oggPage["pageSequenceNumber"] === 1) {} else oggPage[codecFrames$1] = frameStore.get(oggPage)[segments].map((segment) => {
			const header = OpusHeader[getHeaderFromUint8Array](this._identificationHeader, segment, this._headerCache);
			if (header) {
				if (this._preSkipRemaining === null) this._preSkipRemaining = header[preSkip$1];
				let samples = header[frameSize] * header[frameCount] / 1e3 * header[sampleRate];
				if (this._preSkipRemaining > 0) {
					this._preSkipRemaining -= samples;
					samples = this._preSkipRemaining < 0 ? -this._preSkipRemaining : 0;
				}
				return new OpusFrame(segment, header, samples);
			}
			this._codecParser[logError$1]("Failed to parse Ogg Opus Header", "Not a valid Ogg Opus file");
		});
		return oggPage;
	}
};
//#endregion
//#region node_modules/codec-parser/src/codecs/vorbis/VorbisFrame.js
var VorbisFrame = class extends CodecFrame {
	constructor(data, header, samples) {
		super(header, data, samples);
	}
};
//#endregion
//#region node_modules/codec-parser/src/codecs/vorbis/VorbisHeader.js
const blockSizes = {};
for (let i = 0; i < 8; i++) blockSizes[i + 6] = 2 ** (6 + i);
var VorbisHeader = class VorbisHeader extends CodecHeader {
	static [getHeaderFromUint8Array](dataValue, headerCache, vorbisCommentsData, vorbisSetupData) {
		if (dataValue["length"] < 30) throw new Error("Out of data while inside an Ogg Page");
		const key = bytesToString(dataValue[subarray](0, 30));
		const cachedHeader = headerCache[getHeader](key);
		if (cachedHeader) return new VorbisHeader(cachedHeader);
		const header = { [length]: 30 };
		if (key.substr(0, 7) !== "vorbis") return null;
		header[data$1] = uint8Array.from(dataValue[subarray](0, 30));
		const view = new dataView(header[data$1][buffer]);
		header[version] = view.getUint32(7, true);
		if (header["version"] !== 0) return null;
		header[channels$1] = dataValue[11];
		header[channelMode] = vorbisOpusChannelMapping[header["channels"] - 1] || "application defined";
		header[sampleRate] = view.getUint32(12, true);
		header[bitrateMaximum] = view.getInt32(16, true);
		header[bitrateNominal] = view.getInt32(20, true);
		header[bitrateMinimum] = view.getInt32(24, true);
		header[blocksize1] = blockSizes[(dataValue[28] & 240) >> 4];
		header[blocksize0] = blockSizes[dataValue[28] & 15];
		if (header["blocksize0"] > header["blocksize1"]) return null;
		if (dataValue[29] !== 1) return null;
		header[bitDepth] = 32;
		header[vorbisSetup$1] = vorbisSetupData;
		header[vorbisComments] = vorbisCommentsData;
		{
			const { length, data, version, vorbisSetup, vorbisComments, ...codecUpdateFields } = header;
			headerCache[setHeader](key, header, codecUpdateFields);
		}
		return new VorbisHeader(header);
	}
	/**
	* @private
	* Call VorbisHeader.getHeader(Array<Uint8>) to get instance
	*/
	constructor(header) {
		super(header);
		this[bitrateMaximum] = header[bitrateMaximum];
		this[bitrateMinimum] = header[bitrateMinimum];
		this[bitrateNominal] = header[bitrateNominal];
		this[blocksize0] = header[blocksize0];
		this[blocksize1] = header[blocksize1];
		this[data$1] = header[data$1];
		this[vorbisComments] = header[vorbisComments];
		this[vorbisSetup$1] = header[vorbisSetup$1];
	}
};
//#endregion
//#region node_modules/codec-parser/src/codecs/vorbis/VorbisParser.js
var VorbisParser = class extends Parser {
	constructor(codecParser, headerCache, onCodec) {
		super(codecParser, headerCache);
		this.Frame = VorbisFrame;
		onCodec(this[codec]);
		this._identificationHeader = null;
		this._setupComplete = false;
		this._prevBlockSize = null;
	}
	get [codec]() {
		return vorbis;
	}
	[parseOggPage](oggPage) {
		oggPage[codecFrames$1] = [];
		for (const oggPageSegment of frameStore.get(oggPage)[segments]) if (oggPageSegment[0] === 1) {
			this._headerCache[enable]();
			this._identificationHeader = oggPage[data$1];
			this._setupComplete = false;
		} else if (oggPageSegment[0] === 3) this._vorbisComments = oggPageSegment;
		else if (oggPageSegment[0] === 5) {
			this._vorbisSetup = oggPageSegment;
			this._mode = this._parseSetupHeader(oggPageSegment);
			this._setupComplete = true;
		} else if (this._setupComplete) {
			const header = VorbisHeader[getHeaderFromUint8Array](this._identificationHeader, this._headerCache, this._vorbisComments, this._vorbisSetup);
			if (header) oggPage[codecFrames$1].push(new VorbisFrame(oggPageSegment, header, this._getSamples(oggPageSegment, header)));
			else this._codecParser[logError]("Failed to parse Ogg Vorbis Header", "Not a valid Ogg Vorbis file");
		}
		return oggPage;
	}
	_getSamples(segment, header) {
		const currentBlockSize = this._mode.blockFlags[segment[0] >> 1 & this._mode.mask] ? header[blocksize1] : header[blocksize0];
		const samplesValue = this._prevBlockSize === null ? 0 : (this._prevBlockSize + currentBlockSize) / 4;
		this._prevBlockSize = currentBlockSize;
		return samplesValue;
	}
	_parseSetupHeader(setup) {
		const bitReader = new BitReader(setup);
		const mode = {
			count: 0,
			blockFlags: []
		};
		while ((bitReader.read(1) & 1) !== 1);
		let modeBits;
		while (mode.count < 64 && bitReader.position > 0) {
			reverse(bitReader.read(8));
			let currentByte = 0;
			while (bitReader.read(8) === 0 && currentByte++ < 3);
			if (currentByte === 4) {
				modeBits = bitReader.read(7);
				mode.blockFlags.unshift(modeBits & 1);
				bitReader.position += 6;
				mode.count++;
			} else {
				if (((reverse(modeBits) & 126) >> 1) + 1 !== mode.count) this._codecParser[logWarning]("vorbis derived mode count did not match actual mode count");
				break;
			}
		}
		mode.mask = (1 << Math.log2(mode.count)) - 1;
		return mode;
	}
};
//#endregion
//#region node_modules/codec-parser/src/containers/ogg/OggParser.js
var OggStream = class {
	constructor(codecParser, headerCache, onCodec) {
		this._codecParser = codecParser;
		this._headerCache = headerCache;
		this._onCodec = onCodec;
		this._continuedPacket = new uint8Array();
		this._codec = null;
		this._isSupported = null;
		this._previousAbsoluteGranulePosition = null;
	}
	get [codec]() {
		return this._codec || "";
	}
	_updateCodec(codec, Parser) {
		if (this._codec !== codec) {
			this._headerCache[reset]();
			this._parser = new Parser(this._codecParser, this._headerCache, this._onCodec);
			this._codec = codec;
		}
	}
	_checkCodecSupport({ data }) {
		const idString = bytesToString(data[subarray](0, 8));
		switch (idString) {
			case "fishead\0": return false;
			case "OpusHead":
				this._updateCodec("opus", OpusParser);
				return true;
			case /^\x7fFLAC/.test(idString) && idString:
				this._updateCodec("flac", FLACParser);
				return true;
			case /^\x01vorbis/.test(idString) && idString:
				this._updateCodec(vorbis, VorbisParser);
				return true;
			default: return false;
		}
	}
	_checkPageSequenceNumber(oggPage) {
		if (oggPage["pageSequenceNumber"] !== this._pageSequenceNumber + 1 && this._pageSequenceNumber > 1 && oggPage["pageSequenceNumber"] > 1) this._codecParser[logWarning]("Unexpected gap in Ogg Page Sequence Number.", `Expected: ${this._pageSequenceNumber + 1}, Got: ${oggPage[pageSequenceNumber]}`);
		this._pageSequenceNumber = oggPage[pageSequenceNumber];
	}
	_parsePage(oggPage) {
		if (this._isSupported === null) {
			this._pageSequenceNumber = oggPage[pageSequenceNumber];
			this._isSupported = this._checkCodecSupport(oggPage);
		}
		this._checkPageSequenceNumber(oggPage);
		const oggPageStore = frameStore.get(oggPage);
		const headerData = headerStore.get(oggPageStore[header$1]);
		let offset = 0;
		oggPageStore[segments] = headerData[pageSegmentTable].map((segmentLength) => oggPage[data$1][subarray](offset, offset += segmentLength));
		if (this._continuedPacket["length"]) {
			oggPageStore[segments][0] = concatBuffers(this._continuedPacket, oggPageStore[segments][0]);
			this._continuedPacket = new uint8Array();
		}
		if (headerData[pageSegmentBytes][headerData[pageSegmentBytes]["length"] - 1] === 255) this._continuedPacket = concatBuffers(this._continuedPacket, oggPageStore[segments].pop());
		if (this._previousAbsoluteGranulePosition !== null) oggPage[samples] = Number(oggPage[absoluteGranulePosition$1] - this._previousAbsoluteGranulePosition);
		this._previousAbsoluteGranulePosition = oggPage[absoluteGranulePosition$1];
		if (this._isSupported) {
			const frame = this._parser[parseOggPage](oggPage);
			this._codecParser[mapFrameStats](frame);
			return frame;
		} else return oggPage;
	}
};
var OggParser = class extends Parser {
	constructor(codecParser, headerCache, onCodec) {
		super(codecParser, headerCache);
		this._onCodec = onCodec;
		this.Frame = OggPage;
		this.Header = OggPageHeader;
		this._streams = /* @__PURE__ */ new Map();
		this._currentSerialNumber = null;
	}
	get [codec]() {
		const oggStream = this._streams.get(this._currentSerialNumber);
		return oggStream ? oggStream.codec : "";
	}
	*[parseFrame]() {
		const oggPage = yield* this[fixedLengthFrameSync](true);
		this._currentSerialNumber = oggPage[streamSerialNumber];
		let oggStream = this._streams.get(this._currentSerialNumber);
		if (!oggStream) {
			oggStream = new OggStream(this._codecParser, this._headerCache, this._onCodec);
			this._streams.set(this._currentSerialNumber, oggStream);
		}
		if (oggPage["isLastPage"]) this._streams.delete(this._currentSerialNumber);
		return oggStream._parsePage(oggPage);
	}
};
//#endregion
//#region node_modules/codec-parser/src/CodecParser.js
const noOp = () => {};
var CodecParser = class {
	constructor(mimeType, { onCodec, onCodecHeader, onCodecUpdate, enableLogging = false, enableFrameCRC32 = true } = {}) {
		this._inputMimeType = mimeType;
		this._onCodec = onCodec || noOp;
		this._onCodecHeader = onCodecHeader || noOp;
		this._onCodecUpdate = onCodecUpdate;
		this._enableLogging = enableLogging;
		this._crc32 = enableFrameCRC32 ? crc32Function : noOp;
		this[reset]();
	}
	/**
	* @public
	* @returns The detected codec
	*/
	get [codec]() {
		return this._parser ? this._parser[codec] : "";
	}
	[reset]() {
		this._headerCache = new HeaderCache(this._onCodecHeader, this._onCodecUpdate);
		this._generator = this._getGenerator();
		this._generator.next();
	}
	/**
	* @public
	* @description Generator function that yields any buffered CodecFrames and resets the CodecParser
	* @returns {Iterable<CodecFrame|OggPage>} Iterator that operates over the codec data.
	* @yields {CodecFrame|OggPage} Parsed codec or ogg page data
	*/
	*flush() {
		this._flushing = true;
		for (let i = this._generator.next(); i.value; i = this._generator.next()) yield i.value;
		this._flushing = false;
		this[reset]();
	}
	/**
	* @public
	* @description Generator function takes in a Uint8Array of data and returns a CodecFrame from the data for each iteration
	* @param {Uint8Array} chunk Next chunk of codec data to read
	* @returns {Iterable<CodecFrame|OggPage>} Iterator that operates over the codec data.
	* @yields {CodecFrame|OggPage} Parsed codec or ogg page data
	*/
	*parseChunk(chunk) {
		for (let i = this._generator.next(chunk); i.value; i = this._generator.next()) yield i.value;
	}
	/**
	* @public
	* @description Parses an entire file and returns all of the contained frames.
	* @param {Uint8Array} fileData Coded data to read
	* @returns {Array<CodecFrame|OggPage>} CodecFrames
	*/
	parseAll(fileData) {
		return [...this.parseChunk(fileData), ...this.flush()];
	}
	/**
	* @private
	*/
	*_getGenerator() {
		if (this._inputMimeType.match(/aac/)) this._parser = new AACParser(this, this._headerCache, this._onCodec);
		else if (this._inputMimeType.match(/mpeg/)) this._parser = new MPEGParser(this, this._headerCache, this._onCodec);
		else if (this._inputMimeType.match(/flac/)) this._parser = new FLACParser(this, this._headerCache, this._onCodec);
		else if (this._inputMimeType.match(/ogg/)) this._parser = new OggParser(this, this._headerCache, this._onCodec);
		else throw new Error(`Unsupported Codec ${mimeType}`);
		this._frameNumber = 0;
		this._currentReadPosition = 0;
		this._totalBytesIn = 0;
		this._totalBytesOut = 0;
		this._totalSamples = 0;
		this._sampleRate = void 0;
		this._rawData = new Uint8Array(0);
		while (true) {
			const frame = yield* this._parser[parseFrame]();
			if (frame) yield frame;
		}
	}
	/**
	* @protected
	* @param {number} minSize Minimum bytes to have present in buffer
	* @returns {Uint8Array} rawData
	*/
	*[readRawData](minSize = 0, readOffset = 0) {
		let rawData;
		while (this._rawData[length] <= minSize + readOffset) {
			rawData = yield;
			if (this._flushing) return this._rawData[subarray](readOffset);
			if (rawData) {
				this._totalBytesIn += rawData[length];
				this._rawData = concatBuffers(this._rawData, rawData);
			}
		}
		return this._rawData[subarray](readOffset);
	}
	/**
	* @protected
	* @param {number} increment Bytes to increment codec data
	*/
	[incrementRawData](increment) {
		this._currentReadPosition += increment;
		this._rawData = this._rawData[subarray](increment);
	}
	/**
	* @protected
	*/
	[mapCodecFrameStats](frame) {
		this._sampleRate = frame[header$1][sampleRate];
		frame[header$1][bitrate] = frame["duration"] > 0 ? Math.round(frame[data$1][length] / frame[duration]) * 8 : 0;
		frame[frameNumber] = this._frameNumber++;
		frame[totalBytesOut] = this._totalBytesOut;
		frame[totalSamples$1] = this._totalSamples;
		frame[totalDuration] = this._totalSamples / this._sampleRate * 1e3;
		frame[crc32] = this._crc32(frame[data$1]);
		this._headerCache[checkCodecUpdate](frame[header$1][bitrate], frame[totalDuration]);
		this._totalBytesOut += frame[data$1][length];
		this._totalSamples += frame[samples];
	}
	/**
	* @protected
	*/
	[mapFrameStats](frame) {
		if (frame["codecFrames"]) {
			if (frame["isLastPage"]) {
				let absoluteGranulePositionSamples = frame[samples];
				frame[codecFrames$1].forEach((codecFrame) => {
					const untrimmedCodecSamples = codecFrame[samples];
					if (absoluteGranulePositionSamples < untrimmedCodecSamples) {
						codecFrame[samples] = absoluteGranulePositionSamples > 0 ? absoluteGranulePositionSamples : 0;
						codecFrame[duration] = codecFrame[samples] / codecFrame[header$1][sampleRate] * 1e3;
					}
					absoluteGranulePositionSamples -= untrimmedCodecSamples;
					this[mapCodecFrameStats](codecFrame);
				});
			} else {
				frame[samples] = 0;
				frame[codecFrames$1].forEach((codecFrame) => {
					frame[samples] += codecFrame[samples];
					this[mapCodecFrameStats](codecFrame);
				});
			}
			frame[duration] = frame["samples"] / this._sampleRate * 1e3 || 0;
			frame[totalSamples$1] = this._totalSamples;
			frame[totalDuration] = this._totalSamples / this._sampleRate * 1e3 || 0;
			frame[totalBytesOut] = this._totalBytesOut;
		} else this[mapCodecFrameStats](frame);
	}
	/**
	* @private
	*/
	_log(logger, messages) {
		if (this._enableLogging) {
			const stats = [
				`${codec}:         ${this[codec]}`,
				`inputMimeType: ${this._inputMimeType}`,
				`readPosition:  ${this._currentReadPosition}`,
				`totalBytesIn:  ${this._totalBytesIn}`,
				`${totalBytesOut}: ${this._totalBytesOut}`
			];
			const width = Math.max(...stats.map((s) => s[length]));
			messages.push(`--stats--${"-".repeat(width - 9)}`, ...stats, "-".repeat(width));
			logger("codec-parser", messages.reduce((acc, message) => acc + "\n  " + message, ""));
		}
	}
	/**
	* @protected
	*/
	[logWarning](...messages) {
		this._log(console.warn, messages);
	}
	/**
	* @protected
	*/
	[logError$1](...messages) {
		this._log(console.error, messages);
	}
};
//#endregion
//#region node_modules/codec-parser/index.js
var codec_parser_default = CodecParser;
const absoluteGranulePosition = absoluteGranulePosition$1;
const codecFrames = codecFrames$1;
const coupledStreamCount = coupledStreamCount$1;
const data = data$1;
const header = header$1;
const isLastPage = isLastPage$1;
const preSkip = preSkip$1;
const vorbisSetup = vorbisSetup$1;
const channelMappingTable = channelMappingTable$1;
const channels = channels$1;
const streamCount = streamCount$1;
const totalSamples = totalSamples$1;
//#endregion
export { codec_parser_default as a, header as c, streamCount as d, totalSamples as f, codecFrames as i, isLastPage as l, channelMappingTable as n, coupledStreamCount as o, vorbisSetup as p, channels as r, data as s, absoluteGranulePosition as t, preSkip as u };
