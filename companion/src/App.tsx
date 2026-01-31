import { useGateway } from "@/hooks/use-gateway";
import { ChatMessages } from "@/components/chat-messages";
import { ChatComposer } from "@/components/chat-composer";

export default function App() {
  const { connected, messages, stream, busy, send } = useGateway();
  const hasMessages = messages.length > 0 || stream !== null;

  return (
    <div className="flex h-screen flex-col bg-background font-sans text-foreground">
      <div className="flex shrink-0 items-center gap-2 px-4 py-3">
        <div
          className={`size-2 shrink-0 rounded-full ${connected ? "bg-green-500" : "bg-muted-foreground"}`}
        />
        <h1 className="text-sm font-semibold">Companion OS</h1>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {hasMessages ? (
          <ChatMessages messages={messages} stream={stream} busy={busy} />
        ) : (
          <div className="flex-1" />
        )}
      </div>

      {!hasMessages && (
        <h1 className="text-center text-3xl sm:text-4xl font-semibold text-foreground mb-10">
          What can I do for you?
        </h1>
      )}
      <ChatComposer connected={connected} busy={busy} onSend={send} />
      {!hasMessages && <div className="flex-[1.5]" />}
    </div>
  );
}
