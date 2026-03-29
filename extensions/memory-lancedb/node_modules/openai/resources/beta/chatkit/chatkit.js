"use strict";
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChatKit = void 0;
const tslib_1 = require("../../../internal/tslib.js");
const resource_1 = require("../../../core/resource.js");
const SessionsAPI = tslib_1.__importStar(require("./sessions.js"));
const sessions_1 = require("./sessions.js");
const ThreadsAPI = tslib_1.__importStar(require("./threads.js"));
const threads_1 = require("./threads.js");
class ChatKit extends resource_1.APIResource {
    constructor() {
        super(...arguments);
        this.sessions = new SessionsAPI.Sessions(this._client);
        this.threads = new ThreadsAPI.Threads(this._client);
    }
}
exports.ChatKit = ChatKit;
ChatKit.Sessions = sessions_1.Sessions;
ChatKit.Threads = threads_1.Threads;
//# sourceMappingURL=chatkit.js.map