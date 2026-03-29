"use strict";
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
Object.defineProperty(exports, "__esModule", { value: true });
exports.Audio = void 0;
const tslib_1 = require("../../internal/tslib.js");
const resource_1 = require("../../core/resource.js");
const SpeechAPI = tslib_1.__importStar(require("./speech.js"));
const speech_1 = require("./speech.js");
const TranscriptionsAPI = tslib_1.__importStar(require("./transcriptions.js"));
const transcriptions_1 = require("./transcriptions.js");
const TranslationsAPI = tslib_1.__importStar(require("./translations.js"));
const translations_1 = require("./translations.js");
class Audio extends resource_1.APIResource {
    constructor() {
        super(...arguments);
        this.transcriptions = new TranscriptionsAPI.Transcriptions(this._client);
        this.translations = new TranslationsAPI.Translations(this._client);
        this.speech = new SpeechAPI.Speech(this._client);
    }
}
exports.Audio = Audio;
Audio.Transcriptions = transcriptions_1.Transcriptions;
Audio.Translations = translations_1.Translations;
Audio.Speech = speech_1.Speech;
//# sourceMappingURL=audio.js.map