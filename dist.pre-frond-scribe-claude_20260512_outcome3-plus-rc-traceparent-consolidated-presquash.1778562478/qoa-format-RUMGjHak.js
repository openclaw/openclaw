//#region node_modules/@thi.ng/errors/deferror.js
const defError = (prefix, suffix = (msg) => msg !== void 0 ? ": " + msg : "") => class extends Error {
	origMessage;
	constructor(msg) {
		super(prefix(msg) + suffix(msg));
		this.origMessage = msg !== void 0 ? String(msg) : "";
	}
};
//#endregion
//#region node_modules/@thi.ng/errors/illegal-arguments.js
const IllegalArgumentError = defError(() => "illegal argument(s)");
const illegalArgs = (msg) => {
	throw new IllegalArgumentError(msg);
};
//#endregion
//#region node_modules/@thi.ng/errors/illegal-state.js
const IllegalStateError = defError(() => "illegal state");
const illegalState = (msg) => {
	throw new IllegalStateError(msg);
};
//#endregion
//#region node_modules/@thi.ng/bitstream/input.js
const U32 = 4294967296;
var BitInputStream = class {
	buffer;
	start;
	limit;
	pos;
	bitPos;
	bit;
	constructor(buffer, offset = 0, limit = buffer.length << 3) {
		this.buffer = buffer;
		this.start = offset;
		this.limit = limit;
		this.seek(offset);
	}
	*[Symbol.iterator]() {
		let j = this.start;
		let i = j >>> 3;
		let b = 7 - (j & 7);
		while (j < this.limit) {
			yield this.buffer[i] >>> b & 1;
			if (--b < 0) {
				i++;
				b = 7;
			}
			j++;
		}
	}
	get length() {
		return this.limit;
	}
	get position() {
		return this.bitPos;
	}
	seek(pos) {
		if (pos < this.start || pos >= this.limit) illegalArgs(`seek pos out of bounds: ${pos}`);
		this.pos = pos >>> 3;
		this.bit = 8 - (pos & 7);
		this.bitPos = pos;
		return this;
	}
	read(wordSize = 1, safe = true) {
		if (wordSize > 32) return this.read(wordSize - 32, safe) * U32 + this.read(32, safe);
		else if (wordSize > 8) {
			let out = 0;
			let n = wordSize & -8;
			let msb = wordSize - n;
			if (msb > 0) out = this._read(msb, safe);
			while (n > 0) {
				out = (out << 8 | this._read(8, safe)) >>> 0;
				n -= 8;
			}
			return out;
		} else return this._read(wordSize, safe);
	}
	readFields(fields, safe = true) {
		return fields.map((word) => this.read(word, safe));
	}
	readWords(n, wordSize = 8, safe = true) {
		let out = [];
		while (n-- > 0) out.push(this.read(wordSize, safe));
		return out;
	}
	readStruct(fields, safe = true) {
		return fields.reduce((acc, [id, word]) => {
			return acc[id] = this.read(word, safe), acc;
		}, {});
	}
	readBit(safe = true) {
		safe && this.checkLimit(1);
		this.bit--;
		this.bitPos++;
		let out = this.buffer[this.pos] >>> this.bit & 1;
		if (this.bit === 0) {
			this.pos++;
			this.bit = 8;
		}
		return out;
	}
	_read(wordSize, safe = true) {
		safe && this.checkLimit(wordSize);
		let l = this.bit - wordSize, out;
		if (l >= 0) {
			this.bit = l;
			out = this.buffer[this.pos] >>> l & (1 << wordSize) - 1;
			if (l === 0) {
				this.pos++;
				this.bit = 8;
			}
		} else {
			out = (this.buffer[this.pos++] & (1 << this.bit) - 1) << -l;
			this.bit = 8 + l;
			out = out | this.buffer[this.pos] >>> this.bit;
		}
		this.bitPos += wordSize;
		return out;
	}
	checkLimit(requested) {
		if (this.bitPos + requested > this.limit) illegalState(`can't read past EOF`);
	}
};
function qoa_clamp(v, min, max) {
	return v < min ? min : v > max ? max : v;
}
function LMS(h, w) {
	return {
		history: new Int16Array(h || 4),
		weights: new Int16Array(w || 4)
	};
}
function qoa_lms_predict(weights, history) {
	return weights[0] * history[0] + weights[1] * history[1] + weights[2] * history[2] + weights[3] * history[3] >> 13;
}
function qoa_lms_update(weights, history, sample, residual) {
	let delta = residual >> 4;
	weights[0] += history[0] < 0 ? -delta : delta;
	weights[1] += history[1] < 0 ? -delta : delta;
	weights[2] += history[2] < 0 ? -delta : delta;
	weights[3] += history[3] < 0 ? -delta : delta;
	history[0] = history[1];
	history[1] = history[2];
	history[2] = history[3];
	history[3] = sample;
}
const qoa_round = (num) => Math.sign(num) * Math.round(Math.abs(num));
const qoa_scalefactor_tab = Array(16).fill().map((_, s) => qoa_round(Math.pow(s + 1, 2.75)));
const dqt = [
	.75,
	-.75,
	2.5,
	-2.5,
	4.5,
	-4.5,
	7,
	-7
];
const qoa_dequant_tab = qoa_scalefactor_tab.map((sf) => {
	return dqt.map((dq) => qoa_round(dq * sf));
});
//#endregion
//#region node_modules/qoa-format/decode.js
function decodeHeader(stream) {
	if (stream.read(32) !== 1903124838) throw new Error(`Not a QOA file; expected magic number 'qoaf'`);
	const header = {
		samples: stream.read(32),
		channels: stream.read(8),
		sampleRate: stream.read(24)
	};
	stream.seek(64);
	return header;
}
function qoa_decode_frame(stream, audio, lmses, channelData, sampleOffset) {
	const channels = stream.read(8);
	const sampleRate = stream.read(24);
	const samples = stream.read(16);
	const frameSize = stream.read(16);
	const dataSize = Math.floor(frameSize - 8 - 16 * channels);
	const maxTotalSamples = Math.floor(dataSize / 8) * 20;
	if (channels != audio.channels || sampleRate != audio.sampleRate || samples * channels > maxTotalSamples) throw new Error(`invalid frame header data`);
	for (let c = 0; c < channels; c++) {
		const lms = lmses[c];
		for (let i = 0; i < 4; i++) {
			let h = stream.read(16);
			lms.history[i] = h;
		}
		for (let i = 0; i < 4; i++) {
			let w = stream.read(16);
			lms.weights[i] = w;
		}
	}
	for (let sample_index = 0; sample_index < samples; sample_index += 20) for (let c = 0; c < channels; c++) {
		const table = qoa_dequant_tab[stream.read(4)];
		const slice_start = sample_index;
		const slice_count = Math.min(sample_index + 20, samples) - slice_start;
		const lms = lmses[c];
		const sampleData = channelData[c];
		let idx = sampleOffset + slice_start;
		const weights = lms.weights;
		const history = lms.history;
		let bitsRemaining = 60;
		for (let i = 0; i < slice_count; i++) {
			const predicted = qoa_lms_predict(weights, history);
			const dequantized = table[stream.read(3)];
			const reconstructed = qoa_clamp(predicted + dequantized, -32768, 32767);
			const sample = reconstructed < 0 ? reconstructed / 32768 : reconstructed / 32767;
			sampleData[idx++] = sample;
			qoa_lms_update(weights, history, reconstructed, dequantized);
			bitsRemaining -= 3;
		}
		if (bitsRemaining > 0) stream.read(bitsRemaining);
	}
	return samples;
}
function decode(data) {
	if (data.byteLength < 16) throw new Error(`QOA file size must be >= 16`);
	const stream = new BitInputStream(data);
	const audio = decodeHeader(stream);
	const channelData = [];
	const lmses = [];
	for (let c = 0; c < audio.channels; c++) {
		const d = new Float32Array(audio.samples);
		channelData.push(d);
		lmses.push(LMS());
	}
	let sampleIndex = 0;
	let frameLen = 0;
	do {
		frameLen = qoa_decode_frame(stream, audio, lmses, channelData, sampleIndex);
		sampleIndex += frameLen;
	} while (frameLen && sampleIndex < audio.samples);
	return {
		...audio,
		channelData
	};
}
qoa_scalefactor_tab.map((s) => Math.floor((65536 + s - 1) / s));
//#endregion
export { decode };
