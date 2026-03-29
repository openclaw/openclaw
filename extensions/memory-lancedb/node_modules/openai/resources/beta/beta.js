"use strict";
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
Object.defineProperty(exports, "__esModule", { value: true });
exports.Beta = void 0;
const tslib_1 = require("../../internal/tslib.js");
const resource_1 = require("../../core/resource.js");
const AssistantsAPI = tslib_1.__importStar(require("./assistants.js"));
const assistants_1 = require("./assistants.js");
const RealtimeAPI = tslib_1.__importStar(require("./realtime/realtime.js"));
const realtime_1 = require("./realtime/realtime.js");
const ChatKitAPI = tslib_1.__importStar(require("./chatkit/chatkit.js"));
const chatkit_1 = require("./chatkit/chatkit.js");
const ThreadsAPI = tslib_1.__importStar(require("./threads/threads.js"));
const threads_1 = require("./threads/threads.js");
class Beta extends resource_1.APIResource {
    constructor() {
        super(...arguments);
        this.realtime = new RealtimeAPI.Realtime(this._client);
        this.chatkit = new ChatKitAPI.ChatKit(this._client);
        this.assistants = new AssistantsAPI.Assistants(this._client);
        this.threads = new ThreadsAPI.Threads(this._client);
    }
}
exports.Beta = Beta;
Beta.Realtime = realtime_1.Realtime;
Beta.ChatKit = chatkit_1.ChatKit;
Beta.Assistants = assistants_1.Assistants;
Beta.Threads = threads_1.Threads;
//# sourceMappingURL=beta.js.map