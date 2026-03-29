"use strict";
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
Object.defineProperty(exports, "__esModule", { value: true });
exports.Conversations = void 0;
const tslib_1 = require("../../internal/tslib.js");
const resource_1 = require("../../core/resource.js");
const ItemsAPI = tslib_1.__importStar(require("./items.js"));
const items_1 = require("./items.js");
const path_1 = require("../../internal/utils/path.js");
/**
 * Manage conversations and conversation items.
 */
class Conversations extends resource_1.APIResource {
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
        return this._client.get((0, path_1.path) `/conversations/${conversationID}`, options);
    }
    /**
     * Update a conversation
     */
    update(conversationID, body, options) {
        return this._client.post((0, path_1.path) `/conversations/${conversationID}`, { body, ...options });
    }
    /**
     * Delete a conversation. Items in the conversation will not be deleted.
     */
    delete(conversationID, options) {
        return this._client.delete((0, path_1.path) `/conversations/${conversationID}`, options);
    }
}
exports.Conversations = Conversations;
Conversations.Items = items_1.Items;
//# sourceMappingURL=conversations.js.map