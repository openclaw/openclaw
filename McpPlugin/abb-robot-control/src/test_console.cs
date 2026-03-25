using System;
using System.Threading.Tasks;

class P {
    static async Task Main() {
        var b = new ABBBridge();
        Console.WriteLine("Scanning...");
        var scan = await b.ScanControllers(new {});
        Console.WriteLine(scan);
        Console.WriteLine("Connecting to local...");
        var r = await b.Connect(new { host = "127.0.0.1" });
        Console.WriteLine(r);
        var success = r.GetType().GetProperty("success")?.GetValue(r)?.ToString();
        if(success == "True") {
            Console.WriteLine("GetStatus:");
            Console.WriteLine(await b.GetStatus(new {}));
            Console.WriteLine("GetSystemInfo:");
            Console.WriteLine(await b.GetSystemInfo(new {}));
            Console.WriteLine("ListTasks:");
            Console.WriteLine(await b.ListTasks(new {}));
            Console.WriteLine("Disconnect...");
            await b.Disconnect(new {});
        }
    }
}
