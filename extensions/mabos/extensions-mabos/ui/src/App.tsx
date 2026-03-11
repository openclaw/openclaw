import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
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
      <PanelProvider>
        <ChatProvider>
          <RouterProvider router={router} />
        </ChatProvider>
      </PanelProvider>
    </QueryClientProvider>
  );
}
