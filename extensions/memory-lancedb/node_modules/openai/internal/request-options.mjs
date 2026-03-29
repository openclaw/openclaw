// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
export const FallbackEncoder = ({ headers, body }) => {
    return {
        bodyHeaders: {
            'content-type': 'application/json',
        },
        body: JSON.stringify(body),
    };
};
//# sourceMappingURL=request-options.mjs.map