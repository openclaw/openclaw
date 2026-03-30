import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { CommandPalette } from "./components/command-palette/CommandPalette";
import { BusinessProvider } from "./contexts/BusinessContext";
import { ChatProvider } from "./contexts/ChatContext";
import { PanelProvider } from "./contexts/PanelContext";
import { router } from "./router";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
});

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BusinessProvider>
        <PanelProvider>
          <ChatProvider>
            <CommandPalette />
            <RouterProvider router={router} />
          </ChatProvider>
        </PanelProvider>
      </BusinessProvider>
    </QueryClientProvider>
  );
}
