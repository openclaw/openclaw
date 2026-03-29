// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
import { APIResource } from "../../../core/resource.mjs";
import * as SessionsAPI from "./sessions.mjs";
import { Sessions, } from "./sessions.mjs";
import * as TranscriptionSessionsAPI from "./transcription-sessions.mjs";
import { TranscriptionSessions, } from "./transcription-sessions.mjs";
/**
 * @deprecated Realtime has now launched and is generally available. The old beta API is now deprecated.
 */
export class Realtime extends APIResource {
    constructor() {
        super(...arguments);
        this.sessions = new SessionsAPI.Sessions(this._client);
        this.transcriptionSessions = new TranscriptionSessionsAPI.TranscriptionSessions(this._client);
    }
}
Realtime.Sessions = Sessions;
Realtime.TranscriptionSessions = TranscriptionSessions;
//# sourceMappingURL=realtime.mjs.map