// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
import { APIResource } from "../../core/resource.mjs";
import * as ItemsAPI from "./items.mjs";
import { Items, } from "./items.mjs";
import { path } from "../../internal/utils/path.mjs";
/**
 * Manage conversations and conversation items.
 */
export class Conversations extends APIResource {
    constructor() {
        super(...arguments);
        this.items = new ItemsAPI.Items(this._client);
    }
    /**
     * Create a conversation.
     */
    create(body = {}, options) {
        return this._client.post('/conversations', { body, ...options });
    }
    /**
     * Get a conversation
     */
    retrieve(conversationID, options) {
        return this._client.get(path `/conversations/${conversationID}`, options);
    }
    /**
     * Update a conversation
     */
    update(conversationID, body, options) {
        return this._client.post(path `/conversations/${conversationID}`, { body, ...options });
    }
    /**
     * Delete a conversation. Items in the conversation will not be deleted.
     */
    delete(conversationID, options) {
        return this._client.delete(path `/conversations/${conversationID}`, options);
    }
}
Conversations.Items = Items;
//# sourceMappingURL=conversations.mjs.map