# Conversations

Types:

- <code><a href="./src/resources/conversations/conversations.ts">ComputerScreenshotContent</a></code>
- <code><a href="./src/resources/conversations/conversations.ts">Conversation</a></code>
- <code><a href="./src/resources/conversations/conversations.ts">ConversationDeleted</a></code>
- <code><a href="./src/resources/conversations/conversations.ts">ConversationDeletedResource</a></code>
- <code><a href="./src/resources/conversations/conversations.ts">Message</a></code>
- <code><a href="./src/resources/conversations/conversations.ts">SummaryTextContent</a></code>
- <code><a href="./src/resources/conversations/conversations.ts">TextContent</a></code>
- <code><a href="./src/resources/conversations/conversations.ts">InputTextContent</a></code>
- <code><a href="./src/resources/conversations/conversations.ts">OutputTextContent</a></code>
- <code><a href="./src/resources/conversations/conversations.ts">RefusalContent</a></code>
- <code><a href="./src/resources/conversations/conversations.ts">InputImageContent</a></code>
- <code><a href="./src/resources/conversations/conversations.ts">InputFileContent</a></code>

Methods:

- <code title="post /conversations">client.conversations.<a href="./src/resources/conversations/conversations.ts">create</a>({ ...params }) -> Conversation</code>
- <code title="get /conversations/{conversation_id}">client.conversations.<a href="./src/resources/conversations/conversations.ts">retrieve</a>(conversationID) -> Conversation</code>
- <code title="post /conversations/{conversation_id}">client.conversations.<a href="./src/resources/conversations/conversations.ts">update</a>(conversationID, { ...params }) -> Conversation</code>
- <code title="delete /conversations/{conversation_id}">client.conversations.<a href="./src/resources/conversations/conversations.ts">delete</a>(conversationID) -> ConversationDeletedResource</code>

## Items

Types:

- <code><a href="./src/resources/conversations/items.ts">ConversationItem</a></code>
- <code><a href="./src/resources/conversations/items.ts">ConversationItemList</a></code>

Methods:

- <code title="post /conversations/{conversation_id}/items">client.conversations.items.<a href="./src/resources/conversations/items.ts">create</a>(conversationID, { ...params }) -> ConversationItemList</code>
- <code title="get /conversations/{conversation_id}/items/{item_id}">client.conversations.items.<a href="./src/resources/conversations/items.ts">retrieve</a>(itemID, { ...params }) -> ConversationItem</code>
- <code title="get /conversations/{conversation_id}/items">client.conversations.items.<a href="./src/resources/conversations/items.ts">list</a>(conversationID, { ...params }) -> ConversationItemsPage</code>
- <code title="delete /conversations/{conversation_id}/items/{item_id}">client.conversations.items.<a href="./src/resources/conversations/items.ts">delete</a>(itemID, { ...params }) -> Conversation</code>
