using Itfers.Utility;
using System.Text.Json;

namespace ConsoleApp1
{
    public record TronspayApiInfo(decimal trxBalance, decimal usdtBalance, string rechargeAddress, decimal energyPrice);

    public class TronspayApi
    {
        public string userId { get; set; }
        public string secretKey { get; set; }

        public string Host { get; set; } = "https://api.trxdo.com";

        public TronspayApiInfo QueryInfo()
        {
            TronspayApiInfo result = null;

            //查询接口
            var html = string.Empty;
            var url = $"{Host}/api/Energy/QueryInfo";

            var token = DateTime.Now.Stamp(); //当前时间戳
            var sign = Security.GetMD5($"{userId}{token}{secretKey}");

            var post = new { userId = userId, token = token, sign = sign, };

            using (var http = new HttpSys(url))
            {
                http.PostData = JsonHelper.SerializeObject(post);
                http.ContentType = "application/json";
                html = http.ToString();
            }
            try
            {
                var json = JsonHelper.DeserializeObject<JsonElement>(html);
                if (json.TryGetProperty("data", out var data))
                {
                    result = data.Deserialize<TronspayApiInfo>();
                }
            }
            catch { }
            return result;
        }

        /// <summary>
        /// 下单
        /// </summary>
        public (bool, string) SubmitOrder(string address, int number)
        {
            var success = false;
            var message = string.Empty;
            var html = string.Empty;
            var url = $"{Host}/api/Energy/SubmitOrder";

            var token = DateTime.Now.Stamp(); //当前时间戳
            var sign = Security.GetMD5($"{address}{number}{token}{secretKey}");

            var orderPost = new { userId = userId, token = token, sign = sign, address = address, number = number };

            using (var http = new HttpSys(url))
            {
                http.PostData = JsonHelper.SerializeObject(orderPost);
                http.ContentType = "application/json";
                html = http.ToString();
            }
            try
            {
                var json = JsonHelper.DeserializeObject<JsonElement>(html);
                message = json.GetParamString("msg");

                if (json.TryGetProperty("data", out var data))
                {
                    var orderId = data.GetParamString("orderId");
                    success = !string.IsNullOrEmpty(orderId);
                }
            }
            catch { success = false; }
            return (success, message);
        }

        public (bool, string) QueryOrder(string orderId)
        {
            var success = false;
            var message = string.Empty;
            var html = string.Empty;
            var url = $"{Host}/api/Energy/QueryOrder";

            var token = DateTime.Now.Stamp(); //当前时间戳
            var sign = Security.GetMD5($"{orderId}{token}{secretKey}");

            var orderPost = new { userId = userId, token = token, sign = sign, orderId = orderId };

            using (var http = new HttpSys(url))
            {
                http.PostData = JsonHelper.SerializeObject(orderPost);
                http.ContentType = "application/json";
                html = http.ToString();
            }
            try
            {
                var json = JsonHelper.DeserializeObject<JsonElement>(html);
                message = json.GetParamString("msg");

                if (json.TryGetProperty("data", out var data))
                {
                    success = true;
                }
            }
            catch { success = false; }
            return (success, message);
        }
    }

    public class FangTronspayApi : TronspayApi
    {
        public FangTronspayApi()
        {
            userId = "146501555404";/*这里填写您的API ID*/
            secretKey = "81fd639c22911762d8ca7e7c198f4e82";/*这里填写您的API KEY*/
        }
    }
}
