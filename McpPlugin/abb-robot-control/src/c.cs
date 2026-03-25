using System;
using System.Reflection;
using ABB.Robotics.Controllers.RapidDomain;

class P {
    static void Main() {
        Console.WriteLine("RapidSymbol Properties:");
        foreach(var p in typeof(RapidSymbol).GetProperties()) Console.WriteLine(p.Name + " : " + p.PropertyType.Name);
        Console.WriteLine("--- RapidSymbolSearchProperties Properties:");
        foreach(var p in typeof(RapidSymbolSearchProperties).GetProperties()) Console.WriteLine(p.Name + " : " + p.PropertyType.Name);
    }
}
