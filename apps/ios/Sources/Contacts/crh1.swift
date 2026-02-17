import Foundation

// MARK: - Models

struct HunterResult: Codable {
    let source: String          // "web", "github", "repo"
    let title: String
    let url: String?
    let summary: String?
    let extra: [String: String]?
}

enum HunterError: Error {
    case invalidURL
    case requestFailed
    case decodingFailed
    case fileSystemError
}

// MARK: - Hunter Service

final class ContactsService {

    // MARK: - Config

    // TODO: set these before running
    private let bingApiKey: String = "YOUR_BING_API_KEY"
    private let githubToken: String = "YOUR_GITHUB_TOKEN"
    private let githubUser: String = "ram133"
    private let repoName: String = "openclaw"

    // Local repo root on your Mac (absolute path)
    // Example: "/Users/ray/Code/openclaw"
    private let localRepoPath: String = "/ABSOLUTE/PATH/TO/openclaw"

    private let jsonEncoder = JSONEncoder()

    // MARK: - Public entrypoint

    func runFullHunter(keyword: String = "OpenClaw") async {
        do {
            let web = try await searchWeb(keyword: keyword)
            let gh  = try await searchGitHub(keyword: keyword)
            let repo = try scanLocalRepo(for: keyword)

            let all = web + gh + repo

            try saveResults(all, to: "hunter-results-\(timestamp()).json")

            print("✅ Hunter completed. Total results: \(all.count)")
        } catch {
            print("❌ Hunter failed: \(error)")
        }
    }

    // MARK: - Web Search (Bing or compatible API)

    private func searchWeb(keyword: String) async throws -> [HunterResult] {
        // NOTE: This uses Bing Web Search v7 style endpoint as an example.
        // Replace with your actual endpoint if different.
        let encoded = keyword.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? keyword
        guard let url = URL(string: "https://api.bing.microsoft.com/v7.0/search?q=\(encoded)&count=10") else {
            throw HunterError.invalidURL
        }

        var request = URLRequest(url: url)
        request.setValue(bingApiKey, forHTTPHeaderField: "Ocp-Apim-Subscription-Key")

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw HunterError.requestFailed
        }

        // Minimal decoding: we only care about "name" and "url" from webPages.value[]
        struct WebSearchResponse: Decodable {
            struct WebPage: Decodable {
                let name: String?
                let url: String?
                let snippet: String?
            }
            let webPages: WebPages?
            struct WebPages: Decodable {
                let value: [WebPage]
            }
        }

        let decoded = try JSONDecoder().decode(WebSearchResponse.self, from: data)
        let pages = decoded.webPages?.value ?? []

        return pages.map {
            HunterResult(
                source: "web",
                title: $0.name ?? "(no title)",
                url: $0.url,
                summary: $0.snippet,
                extra: nil
            )
        }
    }

    // MARK: - GitHub Search

    private func searchGitHub(keyword: String) async throws -> [HunterResult] {
        let encoded = keyword.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? keyword
        guard let url = URL(string: "https://api.github.com/search/repositories?q=\(encoded)") else {
            throw HunterError.invalidURL
        }

        var request = URLRequest(url: url)
        request.setValue("token \(githubToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw HunterError.requestFailed
        }

        struct GHSearchResponse: Decodable {
            struct Item: Decodable {
                let full_name: String
                let html_url: String
                let description: String?
            }
            let items: [Item]
        }

        let decoded = try JSONDecoder().decode(GHSearchResponse.self, from: data)

        return decoded.items.map {
            HunterResult(
                source: "github",
                title: $0.full_name,
                url: $0.html_url,
                summary: $0.description,
                extra: nil
            )
        }
    }

    // MARK: - Local Repo Scan

    private func scanLocalRepo(for keyword: String) throws -> [HunterResult] {
        let fm = FileManager.default
        let root = URL(fileURLWithPath: localRepoPath)

        guard fm.fileExists(atPath: root.path) else {
            throw HunterError.fileSystemError
        }

        var results: [HunterResult] = []

        let enumerator = fm.enumerator(at: root, includingPropertiesForKeys: nil)
        while let fileURL = enumerator?.nextObject() as? URL {
            guard fileURL.pathExtension == "md" || fileURL.pathExtension == "html" else { continue }

            if let content = try? String(contentsOf: fileURL, encoding: .utf8),
               content.localizedCaseInsensitiveContains(keyword) {

                let relativePath = fileURL.path.replacingOccurrences(of: root.path, with: "")
                let title = fileURL.lastPathComponent

                let snippet = snippetAround(keyword: keyword, in: content)

                let result = HunterResult(
                    source: "repo",
                    title: title,
                    url: relativePath,
                    summary: snippet,
                    extra: nil
                )
                results.append(result)
            }
        }

        return results
    }

    private func snippetAround(keyword: String, in text: String, radius: Int = 80) -> String {
        guard let range = text.range(of: keyword, options: .caseInsensitive) else {
            return String(text.prefix(160))
        }
        let start = text.index(range.lowerBound, offsetBy: -min(radius, text.distance(from: text.startIndex, to: range.lowerBound)), limitedBy: text.startIndex) ?? text.startIndex
        let end = text.index(range.upperBound, offsetBy: min(radius, text.distance(from: range.upperBound, to: text.endIndex)), limitedBy: text.endIndex) ?? text.endIndex
        return String(text[start..<end])
    }

    // MARK: - Save Results

    private func saveResults(_ results: [HunterResult], to fileName: String) throws {
        let data = try jsonEncoder.encode(results)
        jsonEncoder.outputFormatting = [.prettyPrinted, .sortedKeys]

        let fm = FileManager.default
        let root = URL(fileURLWithPath: localRepoPath)
        let outDir = root.appendingPathComponent("hunter-output", isDirectory: true)

        if !fm.fileExists(atPath: outDir.path) {
            try fm.createDirectory(at: outDir, withIntermediateDirectories: true)
        }

        let outFile = outDir.appendingPathComponent(fileName)
        try data.write(to: outFile)

        print("💾 Saved hunter results to: \(outFile.path)")
    }

    // MARK: - Helpers

    private func timestamp() -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyyMMdd-HHmmss"
        return f.string(from: Date())
    }
}
