export const genparkPlugin = {
  id: "genpark",
  initialize: async (config: any) => {
    console.log("Initializing GenPark with token:", config.genpark_api_token);
  },
  sendMessage: async (channelId: string, message: string) => {
    console.log(`Sending message to GenPark circle ${channelId}: ${message}`);
  }
};
