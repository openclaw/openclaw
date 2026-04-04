import Testing
@testable import OpenClaw

@Suite(.serialized)
struct CorrectionWebResearchStoreTests {
    @Test
    func parseSearchDocumentCapturesPublicResultsAndSkipsAds() {
        let document = """
        Title: bot hallucination diagnosis at DuckDuckGo

        1.   capterra.com

        Report Ad [Top 10 Ai For Mental Health](https://duckduckgo.com/y.js?ad_domain=capterra.com)
        3.   en.wikipedia.org

        [https://en.wikipedia.org›wiki › Chatbot_psychosis](https://en.wikipedia.org/wiki/Chatbot_psychosis)   ## [Chatbot psychosis - Wikipedia](https://en.wikipedia.org/wiki/Chatbot_psychosis) The term "AI psychosis" emerged when outlets started reporting incidents on chatbot-related psychotic behavior in mid-2025.
        4.   jamanetwork.com

        [https://jamanetwork.com›journals › jamaotolaryngology › fullarticle › 2817762](https://jamanetwork.com/journals/jamaotolaryngology/fullarticle/2817762)   ## [A Case of Artificial Intelligence Chatbot Hallucination](https://jamanetwork.com/journals/jamaotolaryngology/fullarticle/2817762) Apr 18, 2024 Furthermore, research assessing the AI software currently available has verified LLMs' generation of hallucinations and inaccurate information.
        5.   pubmed.ncbi.nlm.nih.gov

        1.   [## A Case of Artificial Intelligence Chatbot Hallucination](https://pubmed.ncbi.nlm.nih.gov/38635259/) Jun 1, 2024 A Case of Artificial Intelligence Chatbot Hallucination JAMA Otolaryngol Head Neck Surg.
        """

        let items = CorrectionWebResearchStore.parseSearchDocument(document, limit: 3)

        #expect(items.count == 3)
        #expect(items[0].source == "en.wikipedia.org")
        #expect(items[0].title == "Chatbot psychosis - Wikipedia")
        #expect(items[1].source == "jamanetwork.com")
        #expect(items[1].snippet.contains("hallucinations"))
        #expect(items[2].source == "pubmed.ncbi.nlm.nih.gov")
        #expect(items.contains { $0.url.contains("duckduckgo.com/y.js") } == false)
    }
}
