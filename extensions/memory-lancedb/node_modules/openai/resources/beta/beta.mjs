// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
import { APIResource } from "../../core/resource.mjs";
import * as AssistantsAPI from "./assistants.mjs";
import { Assistants, } from "./assistants.mjs";
import * as RealtimeAPI from "./realtime/realtime.mjs";
import { Realtime, } from "./realtime/realtime.mjs";
import * as ChatKitAPI from "./chatkit/chatkit.mjs";
import { ChatKit } from "./chatkit/chatkit.mjs";
import * as ThreadsAPI from "./threads/threads.mjs";
import { Threads, } from "./threads/threads.mjs";
export class Beta extends APIResource {
    constructor() {
        super(...arguments);
        this.realtime = new RealtimeAPI.Realtime(this._client);
        this.chatkit = new ChatKitAPI.ChatKit(this._client);
        this.assistants = new AssistantsAPI.Assistants(this._client);
        this.threads = new ThreadsAPI.Threads(this._client);
    }
}
Beta.Realtime = Realtime;
Beta.ChatKit = ChatKit;
Beta.Assistants = Assistants;
Beta.Threads = Threads;
//# sourceMappingURL=beta.mjs.map