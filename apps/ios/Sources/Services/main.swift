import Foundation

@main
struct HunterCLI {
    static func main() async {
        let service = ContactsService()
        await service.runFullHunter(keyword: "OpenClaw")
    }
}
