import { useState } from "react";
import { useGateway } from "@/hooks/use-gateway";
import { ChatMessages } from "@/components/chat-messages";
import { ChatComposer } from "@/components/chat-composer";

import { SquarePen } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";

export default function App() {
  const { connected, messages, stream, streamParts, busy, send, stop, newSession, historyLoaded } = useGateway();
  const hasMessages = messages.length > 0 || stream !== null;
  const [hasInteracted, setHasInteracted] = useState(false);
  const showEmpty = historyLoaded && !hasMessages && !hasInteracted;

  return (
    <div className="flex h-screen flex-col bg-background font-sans text-foreground">
      <div className="flex shrink-0 items-center justify-between px-4 py-3">
        <h1 className="text-sm font-semibold">Companion OS</h1>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={newSession}
              disabled={!connected}
            >
              <SquarePen className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">New session</TooltipContent>
        </Tooltip>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 flex-col">
          {hasMessages ? (
            <ChatMessages
              messages={messages}
              stream={stream}
              streamParts={streamParts}
              busy={busy}
            />
          ) : (
            <div className="flex-1" />
          )}
        </div>

        {showEmpty && (
          <h1 className="text-center text-3xl sm:text-4xl font-medium text-foreground mb-10">
            What can I do for you?
          </h1>
        )}
        <ChatComposer connected={connected} busy={busy} onSend={(text) => { setHasInteracted(true); send(text); }} onStop={stop} />
        {showEmpty && <div className="flex-[1.5]" />}
      </div>
    </div>
  );
}
