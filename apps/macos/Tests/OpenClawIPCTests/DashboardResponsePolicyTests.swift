import Foundation
import Testing
@testable import OpenClaw

@MainActor
struct DashboardResponsePolicyTests {
    @Test(arguments: [
        ("WebKitErrorDomain", 102, true),
        ("WebKitErrorDomain", 101, false),
        ("WKErrorDomain", 102, false),
        (NSURLErrorDomain, NSURLErrorCancelled, false),
    ], [false, true])
    func `policy interruptions are ignored only after installing a failure page`(
        failure: (String, Int, Bool), isShowingFailurePage: Bool)
    {
        let error = NSError(domain: failure.0, code: failure.1)
        #expect(ControlUIDocumentHost.shouldIgnoreDashboardPolicyInterruption(
            error, isShowingFailurePage: isShowingFailurePage) == (failure.2 && isShowingFailurePage))
    }

    @Test(
        arguments: [200, 303, 399, 400, 401, 403, 500, 503],
        [nil, "text/plain", "application/json", "text/html", "application/xhtml+xml", "TEXT/HTML"])
    func `only non HTML HTTP errors need native recovery`(statusCode: Int, mimeType: String?) throws {
        let url = try #require(URL(string: "https://gateway.example/control/"))
        let response = try #require(HTTPURLResponse(
            url: url, statusCode: statusCode, httpVersion: nil,
            headerFields: mimeType.map { ["Content-Type": $0] }))
        let isHTML = mimeType?.lowercased() == "text/html" || mimeType == "application/xhtml+xml"
        #expect(ControlUIDocumentHost.shouldShowDashboardResponseFailure(
            response, isMainFrame: true, dashboardURL: url) == (statusCode >= 400 && !isHTML))
    }

    @Test(arguments: [
        ("https://gateway.example:443/control/chat", true),
        ("https://gateway.example/oauth", true),
        ("http://gateway.example/control/", false),
        ("https://other.example/control/", false),
        ("https://gateway.example:8443/control/", false),
    ], [false, true])
    func `only main frame responses from the dashboard origin need recovery`(
        source: (String, Bool), isMainFrame: Bool) throws
    {
        let dashboardURL = try #require(URL(string: "https://gateway.example/control/"))
        let sourceURL = try #require(URL(string: source.0))
        let response = try #require(HTTPURLResponse(
            url: sourceURL, statusCode: 403, httpVersion: nil,
            headerFields: ["Content-Type": "text/plain"]))
        #expect(ControlUIDocumentHost.shouldShowDashboardResponseFailure(
            response, isMainFrame: isMainFrame, dashboardURL: dashboardURL) == (source.1 && isMainFrame))
    }

    @Test func `non HTTP responses keep their navigation policy`() throws {
        let url = try #require(URL(string: "https://gateway.example/control/"))
        let response = URLResponse(url: url, mimeType: "text/plain", expectedContentLength: 0, textEncodingName: nil)
        #expect(!ControlUIDocumentHost.shouldShowDashboardResponseFailure(
            response, isMainFrame: true, dashboardURL: url))
    }
}
