export default function register({ registerProvider }: any) {
  registerProvider({
    id: "agnes-ai",
    name: "Agnes AI",
    models: [
      {
        id: "agnes-ai/agnes-1.5-pro",
        name: "Agnes 1.5 Pro",
        type: "text"
      }
    ]
  });
}
