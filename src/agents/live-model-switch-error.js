export class LiveSessionModelSwitchError extends Error {
    provider;
    model;
    authProfileId;
    authProfileIdSource;
    constructor(selection) {
        super(`Live session model switch requested: ${selection.provider}/${selection.model}`);
        this.name = "LiveSessionModelSwitchError";
        this.provider = selection.provider;
        this.model = selection.model;
        this.authProfileId = selection.authProfileId;
        this.authProfileIdSource = selection.authProfileIdSource;
    }
}
