"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChatCompletionRunner = void 0;
const AbstractChatCompletionRunner_1 = require("./AbstractChatCompletionRunner.js");
const chatCompletionUtils_1 = require("./chatCompletionUtils.js");
class ChatCompletionRunner extends AbstractChatCompletionRunner_1.AbstractChatCompletionRunner {
    static runTools(client, params, options) {
        const runner = new ChatCompletionRunner();
        const opts = {
            ...options,
            headers: { ...options?.headers, 'X-Stainless-Helper-Method': 'runTools' },
        };
        runner._run(() => runner._runTools(client, params, opts));
        return runner;
    }
    _addMessage(message, emit = true) {
        super._addMessage(message, emit);
        if ((0, chatCompletionUtils_1.isAssistantMessage)(message) && message.content) {
            this._emit('content', message.content);
        }
    }
}
exports.ChatCompletionRunner = ChatCompletionRunner;
//# sourceMappingURL=ChatCompletionRunner.js.map