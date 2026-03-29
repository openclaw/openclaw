"use strict";
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
Object.defineProperty(exports, "__esModule", { value: true });
exports.Realtime = void 0;
const tslib_1 = require("../../../internal/tslib.js");
const resource_1 = require("../../../core/resource.js");
const SessionsAPI = tslib_1.__importStar(require("./sessions.js"));
const sessions_1 = require("./sessions.js");
const TranscriptionSessionsAPI = tslib_1.__importStar(require("./transcription-sessions.js"));
const transcription_sessions_1 = require("./transcription-sessions.js");
/**
 * @deprecated Realtime has now launched and is generally available. The old beta API is now deprecated.
 */
class Realtime extends resource_1.APIResource {
    constructor() {
        super(...arguments);
        this.sessions = new SessionsAPI.Sessions(this._client);
        this.transcriptionSessions = new TranscriptionSessionsAPI.TranscriptionSessions(this._client);
    }
}
exports.Realtime = Realtime;
Realtime.Sessions = sessions_1.Sessions;
Realtime.TranscriptionSessions = transcription_sessions_1.TranscriptionSessions;
//# sourceMappingURL=realtime.js.map