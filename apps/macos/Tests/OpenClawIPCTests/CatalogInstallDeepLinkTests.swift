import Foundation
import OpenClawKit
import XCTest
@testable import OpenClaw

final class CatalogInstallDeepLinkTests: XCTestCase {
    func testClawHubLinkOpensTheMatchingCatalogPage() throws {
        let link = try XCTUnwrap(CatalogInstallDeepLink(url: XCTUnwrap(URL(
            string: "openclaw://plugins/install?name=openclaw-hello-world"))))
        XCTAssertEqual(link.packageName, "openclaw-hello-world")
        XCTAssertEqual(link.dashboardPath, "/plugins/ch_b3BlbmNsYXctaGVsbG8td29ybGQ")
    }

    func testScopedPackageNameSurvivesURLSearchParamsEncoding() throws {
        let link = try XCTUnwrap(CatalogInstallDeepLink(url: XCTUnwrap(URL(
            string: "openclaw://plugins/install?name=%40owner%2Fscoped-plugin"))))
        XCTAssertEqual(link.packageName, "@owner/scoped-plugin")
        XCTAssertEqual(link.dashboardPath, "/plugins/ch_QG93bmVyL3Njb3BlZC1wbHVnaW4")
    }

    func testSkillLinkOpensReviewForTheExactPublisher() throws {
        let link = try XCTUnwrap(CatalogInstallDeepLink(url: XCTUnwrap(URL(
            string: "openclaw://skills/install?name=%40alice%2Fcalendar"))))
        XCTAssertEqual(link.packageName, "@alice/calendar")
        XCTAssertEqual(link.dashboardPath, "/skills")
        XCTAssertEqual(link.dashboardSearch, "?clawhub=%40alice%2Fcalendar")
    }

    func testTemplateLinkOpensTheMatchingPublishedPackageReview() throws {
        for (name, path) in [
            ("travel-planner", "/templates/packages/travel-planner"),
            ("%40maker%2Ftravel-planner", "/templates/packages/%40maker%2Ftravel-planner"),
        ] {
            let link = try XCTUnwrap(CatalogInstallDeepLink(url: XCTUnwrap(URL(
                string: "openclaw://templates/install?name=\(name)"))))
            XCTAssertEqual(link.dashboardPath, path)
        }
    }

    func testReviewDestinationsPreserveTheTrustedGatewayAndBasePath() throws {
        let base = try XCTUnwrap(URL(string: "https://gateway.example.test/control/#token=fixture-token"))
        for (family, expected) in [
            ("plugins", "/control/plugins/ch_QGFsaWNlL2NhbGVuZGFy"),
            ("skills", "/control/skills?clawhub=%40alice%2Fcalendar"),
            ("templates", "/control/templates/packages/%40alice%2Fcalendar"),
        ] {
            let link = try XCTUnwrap(CatalogInstallDeepLink(url: XCTUnwrap(URL(
                string: "openclaw://\(family)/install?name=%40alice%2Fcalendar"))))
            let destination = try XCTUnwrap(DashboardRouteMap.dashboardURL(
                byAppendingSameAppPath: link.dashboardPath, search: link.dashboardSearch, to: base))
            XCTAssertEqual(destination.absoluteString, "https://gateway.example.test\(expected)#token=fixture-token")
        }
    }

    func testExternalLinksCannotSupplyCommandsOrGatewayAuthority() throws {
        for family in ["plugins", "skills", "templates"] {
            for raw in [
                "openclaw://plugins/install?name=hello&name=other",
                "openclaw://plugins/install?name=hello&url=https://attacker.example/plugin.tgz",
                "openclaw://plugins/install?name=hello&gateway=https://attacker.example",
                "openclaw://user@plugins/install?name=hello",
                "openclaw://plugins:443/install?name=hello",
                "openclaw://plugins/install?name=hello#enable",
                "openclaw://plugins/install?name=../../plugin",
                "openclaw://plugins/install?name=https://attacker.example/plugin.tgz",
                "openclaw://plugins/install?name=hello%0Acommand",
                "openclaw://plugins/install?name=hello%0A",
                "openclaw://plugins/install?name=",
                "https://plugins/install?name=hello",
                "openclaw://plugins/install?name=" + String(repeating: "a", count: 215),
                "openclaw://plugins/install?name=hello&action=install",
                "openclaw://plugins/install/extra?name=hello",
            ] {
                let input = raw.replacingOccurrences(of: "plugins", with: family)
                XCTAssertNil(try CatalogInstallDeepLink(url: XCTUnwrap(URL(string: input))), input)
            }
        }
    }
}
