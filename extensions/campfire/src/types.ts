export type CampfireWebhookPayload = {
  user: {
    id: number;
    name: string;
  };
  room: {
    id: number;
    name: string;
    path: string;
  };
  message: {
    id: number;
    body: {
      html?: string;
      plain: string;
    };
    path: string;
  };
};
