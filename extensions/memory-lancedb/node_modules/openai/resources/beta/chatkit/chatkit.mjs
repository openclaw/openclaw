// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
import { APIResource } from "../../../core/resource.mjs";
import * as SessionsAPI from "./sessions.mjs";
import { Sessions } from "./sessions.mjs";
import * as ThreadsAPI from "./threads.mjs";
import { Threads, } from "./threads.mjs";
export class ChatKit extends APIResource {
    constructor() {
        super(...arguments);
        this.sessions = new SessionsAPI.Sessions(this._client);
        this.threads = new ThreadsAPI.Threads(this._client);
    }
}
ChatKit.Sessions = Sessions;
ChatKit.Threads = Threads;
//# sourceMappingURL=chatkit.mjs.map