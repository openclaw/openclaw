import type { NextFunction, Request, Response } from "express";
export declare function shouldRejectBrowserMutation(params: {
    method: string;
    origin?: string;
    referer?: string;
    secFetchSite?: string;
}): boolean;
export declare function browserMutationGuardMiddleware(): (req: Request, res: Response, next: NextFunction) => void;
