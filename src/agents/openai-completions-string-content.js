export function flattenStringOnlyCompletionContent(content) {
    if (!Array.isArray(content)) {
        return content;
    }
    const textParts = [];
    for (const item of content) {
        if (!item ||
            typeof item !== "object" ||
            item.type !== "text" ||
            typeof item.text !== "string") {
            return content;
        }
        textParts.push(item.text);
    }
    return textParts.join("\n");
}
export function flattenCompletionMessagesToStringContent(messages) {
    return messages.map((message) => {
        if (!message || typeof message !== "object") {
            return message;
        }
        const content = message.content;
        const flattenedContent = flattenStringOnlyCompletionContent(content);
        if (flattenedContent === content) {
            return message;
        }
        return {
            ...message,
            content: flattenedContent,
        };
    });
}
